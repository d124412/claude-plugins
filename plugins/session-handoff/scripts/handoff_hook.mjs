#!/usr/bin/env node
/*
 * 세션 인수인계(handoff) 훅 — 플러그인판(Node). 크로스플랫폼(Win/Mac/Linux).
 * Claude Code 훅이 호출한다. argv[2] 로 모드를 받는다:
 *   compact    : SessionStart(matcher=compact) → 압축 직후 맥락 복원 리마인더를 컨텍스트에 주입
 *   start      : SessionStart(matcher=startup|resume|clear|fork) → 세션 시작 리마인더 주입
 *   precompact : PreCompact → (stdout 미주입) 압축 직전 대화 원본을 .handoff/.archive/ 로 자동 백업
 *   end        : SessionEnd → (stdout 미주입) 이벤트를 감사 로그에 기록
 * 규칙 전문은 플러그인의 RULES.md / `/handoff` 명령 참조.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

function readInput() {
  try {
    const raw = fs.readFileSync(0, 'utf8'); // stdin (fd 0)
    return raw && raw.trim() ? JSON.parse(raw) : {};
  } catch (_) { return {}; }
}

function shortToken(d) {
  const sid = String(d.session_id || d.sessionId || '');
  const tok = sid.toLowerCase().replace(/[^a-z0-9]/g, '');
  return tok ? tok.slice(0, 6) : '';
}

function pad(n) { return String(n).padStart(2, '0'); }

function stampCompact(d) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
       + `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function stampHuman(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
       + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function emitContext(text) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text },
  }));
}

function logEvent(mode, d, note = '') {
  try {
    const logp = path.join(os.homedir(), '.claude', 'handoff-events.log');
    const cwd = d.cwd || d.project_dir || process.cwd();
    const matcher = d.source || d.compaction_reason || d.trigger || d.reason || '';
    fs.appendFileSync(logp,
      `${stampHuman(new Date())}\t${mode}\t${matcher}\t${cwd}\t${note}\n`, 'utf8');
  } catch (_) { /* 훅이 죽으면 안 됨 */ }
}

function pruneArchive(dir, tok, keep = 5) {
  try {
    const pre = tok + '-';
    const files = fs.readdirSync(dir)
      .filter((f) => f.startsWith(pre) && f.endsWith('.jsonl'))
      .sort().reverse(); // 파일명에 타임스탬프 → 내림차순 = 최신순
    for (const f of files.slice(keep)) {
      try { fs.unlinkSync(path.join(dir, f)); } catch (_) {}
    }
  } catch (_) {}
}

function archiveTranscript(d) {
  try {
    const tpath = d.transcript_path || '';
    if (!tpath || !fs.existsSync(tpath) || !fs.statSync(tpath).isFile()) return '';
    const cwd = d.cwd || process.cwd();
    const tok = shortToken(d) || 'nosid';
    const dir = path.join(cwd, '.handoff', '.archive');
    fs.mkdirSync(dir, { recursive: true });
    const name = `${tok}-${stampCompact(new Date())}.jsonl`;
    fs.copyFileSync(tpath, path.join(dir, name));
    pruneArchive(dir, tok, 5);
    return name;
  } catch (_) { return ''; }
}

const START_MSG =
  '[세션 인수인계 — 시작]\n'
  + '세션 인수인계 규칙에 따라 진행한다:\n'
  + '1) 먼저 .handoff/INDEX.md 만 읽어 진행중/중단 세션 현황을 파악한다(폴더/INDEX 없으면 생성).\n'
  + "2) 내 작업과 겹칠 만한 '진행중/중단' 세션이 있으면 그 파일만 열어 확인하고, 겹치면 사용자에게 알린다.\n"
  + '3) 이번 세션 전용 파일 .handoff/<세션식별자>.md 를 만들고 INDEX.md 에 자기 줄을 추가한다.\n'
  + '이후 자기 파일 + INDEX.md 의 자기 줄만 갱신한다(다른 세션 파일은 읽기 확인 외에는 건드리지 않는다). 수동 갱신은 /handoff 명령.';

const COMPACT_MSG =
  '[세션 인수인계 — 압축 복원]\n'
  + '방금 컨텍스트 압축(compact)이 일어났다. 세부 맥락이 요약본으로 대체되어 사라졌을 수 있다. 지금 즉시:\n'
  + '1) 이 프로젝트의 .handoff/INDEX.md 를 읽어 전체 세션 현황을 파악한다.\n'
  + "2) 이번 세션이 소유한 .handoff/<세션식별자>.md 를 다시 읽어 '현재 상태 / 다음에 할 일 / 미해결 이슈'를 복원한다.\n"
  + '3) 내가 어느 세션 파일의 소유자인지 다시 확인하고, 이후 작업 중 그 파일명을 명시하며 이어간다.\n'
  + '아직 이번 세션의 handoff 파일이 없다면 INDEX.md 를 근거로 파악한 뒤 새로 만든다.';

function tokenLineStart(tok) {
  if (tok) {
    return `\n■ 이번 세션 고유 토큰: \`${tok}\`  → 세션식별자는 \`<주제슬러그>-${tok}\` 형식으로 이 토큰을 `
         + `접미사로 붙여 정하라(예: \`traffic-analysis-${tok}\`). 이러면 동시에 도는 다른 세션과 `
         + `파일명이 절대 겹치지 않는다.`;
  }
  return '\n■ (세션 토큰 미확인) 세션식별자는 INDEX.md 의 기존 식별자와 겹치지 않게 짓고, '
       + '겹치면 접미사(-2, -b 등)로 구분하라.';
}

function tokenLineCompact(tok) {
  if (tok) {
    return `\n■ 이번 세션 고유 토큰: \`${tok}\`  → 내 handoff 파일은 \`.handoff/*-${tok}.md\` 이다. `
         + `이 토큰으로 내 파일을 찾아 소유권을 확정한 뒤 이어가라.`
         + `\n■ 압축 직전 대화 원본이 \`.handoff/.archive/${tok}-*.jsonl\` 로 자동 백업돼 있다. `
         + `요약본에서 세부가 사라졌으면 그 중 가장 최근 파일을 읽어(grep) 복구하라.`;
  }
  return '';
}

function main() {
  const mode = process.argv[2] || 'start';
  const data = readInput();
  const tok = shortToken(data);
  if (mode === 'compact') {
    emitContext(COMPACT_MSG + tokenLineCompact(tok));
  } else if (mode === 'start') {
    emitContext(START_MSG + tokenLineStart(tok));
  } else if (mode === 'precompact') {
    const name = archiveTranscript(data);
    logEvent(mode, data, name ? 'archived:' + name : 'archive:skip');
  } else if (mode === 'end') {
    logEvent(mode, data);
  }
  // 알 수 없는 모드는 조용히 무시
}

main();
