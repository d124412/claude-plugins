#!/usr/bin/env node
/*
 * 세션 인수인계(handoff) 훅 — 플러그인판(Node). 크로스플랫폼(Win/Mac/Linux).
 * Claude Code 훅/명령이 호출한다. argv[2] 로 모드를 받는다:
 *   compact    : SessionStart(compact) → 압축 직후 맥락 복원 리마인더 주입
 *   start      : SessionStart(startup|resume|clear|fork) → 세션 시작 리마인더 주입
 *   precompact : PreCompact → 원본 백업 + 무LLM 폴백요약 + 복원 마커
 *   end        : SessionEnd → 감사 로그
 *   prompt     : UserPromptSubmit → 압축 마커 있으면 복원 리마인더 재주입 후 마커 삭제
 *   stop       : Stop → 이 세션 handoff 파일이 없으면 부드럽게 상기
 *   snapshot   : (명령) 압축 없이 지금 대화 원본을 .archive/ 로 스냅샷
 *                node handoff_hook.mjs snapshot --session <uuid> [--cwd <dir>] [--transcript <path>]
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

function handoffDir(d) { return path.join(d.cwd || process.cwd(), '.handoff'); }
function archiveDir(d) { return path.join(handoffDir(d), '.archive'); }

function emit(eventName, text) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: eventName, additionalContext: text },
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

// 자동 압축 백업만 정리(수동 스냅샷 -snap- 은 건드리지 않음)
function pruneArchive(dir, tok, keep = 5) {
  try {
    const pre = tok + '-';
    const files = fs.readdirSync(dir)
      .filter((f) => f.startsWith(pre) && f.endsWith('.jsonl') && !f.includes('-snap-'))
      .sort().reverse();
    for (const f of files.slice(keep)) {
      try { fs.unlinkSync(path.join(dir, f)); } catch (_) {}
    }
  } catch (_) {}
}

// 수동 스냅샷만 별도로 정리(자동 백업을 밀어내지 않도록 분리)
function pruneSnapshots(dir, tok, keep = 3) {
  try {
    const pre = tok + '-snap-';
    const files = fs.readdirSync(dir)
      .filter((f) => f.startsWith(pre) && f.endsWith('.jsonl'))
      .sort().reverse();
    for (const f of files.slice(keep)) {
      try { fs.unlinkSync(path.join(dir, f)); } catch (_) {}
    }
  } catch (_) {}
}

// 압축 직전: 대화 원본을 통째 복사(무손실 안전망), 토큰별 최신 5개 유지
function archiveTranscript(d) {
  try {
    const tpath = d.transcript_path || '';
    if (!tpath || !fs.existsSync(tpath) || !fs.statSync(tpath).isFile()) return '';
    const tok = shortToken(d) || 'nosid';
    const dir = archiveDir(d);
    fs.mkdirSync(dir, { recursive: true });
    const name = `${tok}-${stampCompact(new Date())}.jsonl`;
    fs.copyFileSync(tpath, path.join(dir, name));
    pruneArchive(dir, tok, 5);
    return name;
  } catch (_) { return ''; }
}

// 무LLM 결정론 폴백: transcript 를 기계적으로 파싱해 뼈대 md 생성(항상 성공, 덮어쓰기)
function writeFallback(d) {
  try {
    const tpath = d.transcript_path || '';
    if (!tpath || !fs.existsSync(tpath)) return '';
    const tok = shortToken(d) || 'nosid';
    const lines = fs.readFileSync(tpath, 'utf8').split('\n').filter(Boolean);
    const users = [], assists = [], files = new Set();
    for (const l of lines) {
      let o; try { o = JSON.parse(l); } catch (_) { continue; }
      const m = o.message || o;
      const role = m.role || o.type;
      let content = m.content;
      if (typeof content === 'string') content = [{ type: 'text', text: content }];
      if (!Array.isArray(content)) continue;
      for (const b of content) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text' && b.text) {
          const t = String(b.text).trim();
          if (!t) continue;
          if (role === 'user') users.push(t);
          else if (role === 'assistant') assists.push(t.slice(0, 200));
        } else if (b.type === 'tool_use' && b.input) {
          const fp = b.input.file_path || b.input.path || b.input.notebook_path;
          if (fp) files.add(String(fp));
        }
      }
    }
    const last = (arr, n) => arr.slice(-n);
    const bullet = (s) => '- ' + s.replace(/\s+/g, ' ').slice(0, 300);
    const md =
`# Fallback (규칙 추출 · 무LLM) — ${tok}

> 대화 원본에서 기계적으로 뽑은 뼈대다(LLM 요약 아님). 다른 요약이 없을 때 최소 복구용.
- 생성: ${stampHuman(new Date())} (사유: ${d.compaction_reason || ''})

## 최근 사용자 요청 (원문 발췌)
${last(users, 15).map(bullet).join('\n') || '- (없음)'}

## 최근 편집·언급 파일
${[...files].slice(-30).map((f) => '- ' + f).join('\n') || '- (없음)'}

## 최근 어시스턴트 활동 (발췌, 요약 아님)
${last(assists, 10).map(bullet).join('\n') || '- (없음)'}
`;
    fs.writeFileSync(path.join(archiveDir(d), `${tok}-fallback.md`), md, 'utf8');
    return `${tok}-fallback.md`;
  } catch (_) { return ''; }
}

// 복원 이중화: 압축 마커 남기기 / 소비하기(쓰면 즉시 삭제 → 안 쌓임)
function setRestoreMarker(d) {
  try {
    const tok = shortToken(d); if (!tok) return;
    fs.mkdirSync(archiveDir(d), { recursive: true });
    fs.writeFileSync(path.join(archiveDir(d), `${tok}.restore-pending`),
      stampHuman(new Date()), 'utf8');
  } catch (_) {}
}
function consumeRestoreMarker(d) {
  try {
    const tok = shortToken(d); if (!tok) return false;
    const mk = path.join(archiveDir(d), `${tok}.restore-pending`);
    if (fs.existsSync(mk)) { try { fs.unlinkSync(mk); } catch (_) {} return true; }
  } catch (_) {}
  return false;
}

// 이 세션 handoff 파일(.handoff/*-<토큰>.md) 존재 여부. 모르면 안 건드림(true).
function handoffExists(d) {
  try {
    const tok = shortToken(d); if (!tok) return true;
    const dir = handoffDir(d);
    if (!fs.existsSync(dir)) return false;
    const suffix = `-${tok}.md`;
    return fs.readdirSync(dir).some((f) => f.endsWith(suffix));
  } catch (_) { return true; }
}

// ── snapshot 모드 ────────────────────────────────────────────────
function parseArgs(argv) {
  const out = {};
  for (let i = 3; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--') && i + 1 < argv.length) { out[a.slice(2)] = argv[i + 1]; i++; }
  }
  return out;
}

// Claude Code 가 보관하는 세션 원본(.jsonl) 찾기: ~/.claude/projects/*/<uuid>.jsonl
function findTranscript(sessionId) {
  try {
    if (!sessionId) return '';
    const root = path.join(os.homedir(), '.claude', 'projects');
    if (!fs.existsSync(root)) return '';
    for (const d of fs.readdirSync(root)) {
      const p = path.join(root, d, sessionId + '.jsonl');
      if (fs.existsSync(p)) return p;
    }
  } catch (_) {}
  return '';
}

function doSnapshot(args) {
  const sid = args.session || '';
  const cwd = args.cwd || process.cwd();
  const tpath = args.transcript || findTranscript(sid);
  if (!tpath || !fs.existsSync(tpath)) {
    console.log('SNAPSHOT FAILED: 대화 원본(transcript)을 찾지 못했습니다. '
      + '--session <uuid> 또는 --transcript <path> 를 지정하세요.');
    process.exitCode = 1;
    return;
  }
  const d = { session_id: sid, cwd, transcript_path: tpath, compaction_reason: 'manual-snapshot' };
  const tok = shortToken(d) || 'nosid';
  const dir = archiveDir(d);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const name = `${tok}-snap-${stampCompact(new Date())}.jsonl`;
    const dest = path.join(dir, name);
    fs.copyFileSync(tpath, dest);
    pruneSnapshots(dir, tok, 3);
    const fb = writeFallback(d);
    const mb = (fs.statSync(dest).size / 1048576).toFixed(2);
    logEvent('snapshot', d, `snapshot:${name} fallback:${fb || 'skip'}`);
    console.log(`SNAPSHOT OK
- 원본 스냅샷 : ${name}  (${mb} MB)
- 폴백 요약   : ${fb || '(생성 안 됨)'}
- 위치        : ${dir}
- 보관 정책   : 수동 스냅샷 최신 3개 유지(자동 압축백업과 분리)`);
  } catch (e) {
    console.log('SNAPSHOT FAILED:', String(e && e.message ? e.message : e));
    process.exitCode = 1;
  }
}

// ── 메시지 ───────────────────────────────────────────────────────
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
  + '아직 이번 세션의 handoff 파일이 없다면 INDEX.md 를 근거로 파악한 뒤 새로 만든다.\n'
  + '■ 중요: 요약본을 그대로 믿지 말고, 필요한 실제 소스 파일을 다시 열어(Read) 확인한 뒤 작업하라. 요약은 부정확할 수 있다.';

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
         + `세부가 사라졌으면 그 중 가장 최근 파일을 읽어(grep) 복구하라.`
         + `\n■ 빠른 복원용 뼈대 요약이 \`.handoff/.archive/${tok}-fallback.md\` 에 있다(무LLM 규칙추출).`;
  }
  return '';
}

function restoreMsg(tok) {
  return `[세션 인수인계 — 압축 복원 재확인] 직전에 컨텍스트 압축이 있었다. 아직 맥락을 복원하지 않았다면 지금:\n`
       + `1) .handoff/INDEX.md 와 내 세션 파일 .handoff/*-${tok}.md 를 읽는다.\n`
       + `2) 세부가 필요하면 .handoff/.archive/${tok}-*.jsonl(원본) 또는 ${tok}-fallback.md(뼈대 요약) 를 grep.\n`
       + `3) 요약을 맹신하지 말고 실제 소스 파일을 다시 열어 확인하라. (이미 복원했다면 무시.)`;
}

function stopNudge(tok) {
  return `[세션 인수인계] 이 세션의 handoff 파일(.handoff/<주제>-${tok}.md)이 아직 없다. `
       + `의미 있는 작업을 했다면 /handoff 로 현재 상태를 남겨두면 다음 세션(또는 압축 후)이 이어갈 수 있다.`;
}

function main() {
  const mode = process.argv[2] || 'start';

  if (mode === 'snapshot') { doSnapshot(parseArgs(process.argv)); return; }

  const data = readInput();
  const tok = shortToken(data);
  if (mode === 'compact') {
    emit('SessionStart', COMPACT_MSG + tokenLineCompact(tok));
  } else if (mode === 'start') {
    emit('SessionStart', START_MSG + tokenLineStart(tok));
  } else if (mode === 'precompact') {
    const a = archiveTranscript(data);
    const f = writeFallback(data);
    setRestoreMarker(data);
    logEvent(mode, data, `archived:${a || 'skip'} fallback:${f || 'skip'}`);
  } else if (mode === 'end') {
    logEvent(mode, data);
  } else if (mode === 'prompt') {
    if (tok && consumeRestoreMarker(data)) emit('UserPromptSubmit', restoreMsg(tok));
  } else if (mode === 'stop') {
    if (tok && !handoffExists(data)) emit('Stop', stopNudge(tok));
  }
  // 알 수 없는 모드는 조용히 무시
}

main();
