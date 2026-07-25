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
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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

// 크로스플랫폼 파일명 추출. transcript 의 도구 인자에는 다른 OS 에서 쓰인 경로가
// 섞여 있을 수 있어(Windows \ · POSIX /), path.basename(현재 OS 전용)로는 반대 구분자를
// 못 자른다. 두 구분자를 모두 기준으로 마지막 조각을 취한다.
function baseName(p) {
  const s = String(p).replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
  return i >= 0 ? s.slice(i + 1) : s;
}

// transcript 앞부분에서 '세션 시작 시점의 cwd' 를 읽는다.
// 훅에 오는 cwd 는 셸 cd 를 따라 하위 디렉터리로 바뀔 수 있어(예: <프로젝트>/.handoff)
// 그대로 믿으면 .handoff/.handoff 를 찾는 오판이 난다. 첫 엔트리는 오염되지 않는다.
// (끝부분이 아니라 앞부분을 읽는 이유 = cd 이후 엔트리는 바뀐 경로가 찍히기 때문)
function rootFromTranscript(tpath) {
  try {
    if (!tpath || !fs.existsSync(tpath)) return null;
    const size = fs.statSync(tpath).size;
    if (!size) return null;
    const fd = fs.openSync(tpath, 'r');
    const buf = Buffer.alloc(Math.min(65536, size));
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(buf.toString('utf8'));
    return m ? JSON.parse('"' + m[1] + '"') : null;
  } catch (_) { return null; }
}

// 프로젝트 루트를 '확실히' 알 때만 돌려준다. 모르면 null → 호출자가 판정을 포기한다.
// 추측(process.cwd())은 하지 않는다. 엉뚱한 .handoff/ 를 보고 오판하느니 아무 말도 안 하는 게 낫다.
function explicitRoot(d) {
  const t = rootFromTranscript(d.transcript_path);
  if (t) return t;
  const cand = d.cwd || d.project_dir || process.env.CLAUDE_PROJECT_DIR || null;
  if (!cand) return null;
  // 하위 디렉터리로 오염된 경우(셸 cd)를 위로 올라가며 복구한다. .handoff 가 있는 조상을 찾는다.
  try {
    let cur = path.resolve(cand);
    for (let i = 0; i < 4; i++) {
      if (fs.existsSync(path.join(cur, '.handoff'))) return cur;
      const up = path.dirname(cur);
      if (up === cur) break;
      cur = up;
    }
  } catch (_) {}
  return cand;
}
function handoffDir(d) {
  return path.join(explicitRoot(d) || process.cwd(), '.handoff');
}

// 세션 = 디렉터리. 폴더명은 `<주제슬러그>-<토큰>` 이고, 주제가 아직 없으면 `<토큰>` 이다.
// 항상 토큰으로 찾으므로, /handoff 가 나중에 주제를 붙여 폴더명을 바꿔도 같은 폴더를 계속 쓴다.
function sessionDir(d, create = false) {
  const base = handoffDir(d);
  const tok = shortToken(d) || 'nosid';
  try {
    const hit = fs.readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory()).map((e) => e.name)
      .find((n) => n === tok || n.endsWith('-' + tok));
    if (hit) {
      const dir = path.join(base, hit);
      if (create) ensureSession(d, dir, tok);
      return dir;
    }
  } catch (_) {}
  // 구 레이아웃의 `<주제>-<토큰>.md` 가 있으면 그 주제를 폴더명으로 물려받는다(이름이 살아남게).
  let name = tok;
  try {
    const legacy = fs.readdirSync(base).find((f) => f.endsWith(`-${tok}.md`));
    if (legacy) name = legacy.slice(0, -3);
  } catch (_) {}
  const dir = path.join(base, name);
  if (create) ensureSession(d, dir, tok);
  return dir;
}
function ensureSession(d, dir, tok) {
  try {
    fs.mkdirSync(path.join(dir, 'archive'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'restore'), { recursive: true });
    migrateLegacy(d, dir, tok);
  } catch (_) {}
}
// 구 레이아웃 잔재가 '내 토큰에 대해' 있는지만 본다. 없으면 아무것도 만들지 않는다
// (작업이 없는 세션에 빈 폴더가 생기지 않게).
function hasLegacy(d, tok) {
  try {
    const base = handoffDir(d);
    if (!fs.existsSync(base)) return false;
    const old = path.join(base, '.archive');
    if (fs.existsSync(old) && fs.readdirSync(old)
      .some((f) => f.startsWith(tok + '-') || f === `${tok}.restore-pending`)) return true;
    return fs.readdirSync(base).some((f) => f.endsWith(`-${tok}.md`));
  } catch (_) { return false; }
}

// 세션 시작 시 1회: 구 평면 구조가 남아 있으면 새 세션 폴더로 복사한다(원본은 보존).
// 이관이 '압축/스냅샷/복원 때까지' 미뤄지면 언제 반영되는지 예측할 수 없어서, 시작 시점에 당긴다.
function migrateIfNeeded(d) {
  try {
    const tok = shortToken(d);
    // 루트를 모르면 이관도 하지 않는다(엉뚱한 곳에 폴더를 만들지 않기 위해).
    if (!tok || !explicitRoot(d) || !hasLegacy(d, tok)) return false;
    sessionDir(d, true);          // ensureSession → migrateLegacy
    logEvent('migrate', d, `token:${tok}`);
    return true;
  } catch (_) { return false; }
}

function archiveDir(d, create = false) { return path.join(sessionDir(d, create), 'archive'); }
function restoreDir(d, create = false) { return path.join(sessionDir(d, create), 'restore'); }

// 구 레이아웃(.handoff/.archive/<토큰>-*, .handoff/<주제>-<토큰>.md)에서 세션 폴더로 **복사**한다.
// 원본은 지우지 않는다(사용자 지시). 이미 있는 대상은 건너뛰므로 여러 번 돌아도 안전하다.
function migrateLegacy(d, sdir, tok) {
  try {
    const base = handoffDir(d);
    const old = path.join(base, '.archive');
    if (fs.existsSync(old)) {
      for (const f of fs.readdirSync(old)) {
        let dest = null;
        if (f.startsWith(tok + '-') && f.endsWith('.jsonl')) {
          const rest = f.slice(tok.length + 1);           // '<시각>.jsonl' 또는 'snap-<시각>.jsonl'
          dest = path.join(sdir, 'archive', rest.startsWith('snap-') ? rest : 'compact-' + rest);
        } else if (f === `${tok}-fallback.md`) {
          dest = path.join(sdir, 'fallback.md');
        } else if (f === `${tok}.restore-pending`) {
          dest = path.join(sdir, 'restore-pending');
        }
        if (!dest || fs.existsSync(dest)) continue;
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(path.join(old, f), dest);
      }
    }
    const cur = fs.readdirSync(base).find((f) => f.endsWith(`-${tok}.md`));
    const dst = path.join(sdir, 'handoff.md');
    if (cur && !fs.existsSync(dst)) fs.copyFileSync(path.join(base, cur), dst);
  } catch (_) {}
}

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

// 세션 폴더 안에서 종류별로 따로 정리한다(수동 스냅샷이 자동 백업을 밀어내지 않도록 분리).
function prunePrefixed(dir, prefix, keep) {
  try {
    const files = fs.readdirSync(dir)
      .filter((f) => f.startsWith(prefix) && f.endsWith('.jsonl'))
      .sort().reverse();
    for (const f of files.slice(keep)) {
      try { fs.unlinkSync(path.join(dir, f)); } catch (_) {}
    }
  } catch (_) {}
}
const pruneArchive = (dir, keep = 5) => prunePrefixed(dir, 'compact-', keep);
const pruneSnapshots = (dir, keep = 3) => prunePrefixed(dir, 'snap-', keep);

// 압축 직전: 대화 원본을 통째 복사(무손실 안전망), 토큰별 최신 5개 유지
function archiveTranscript(d) {
  try {
    const tpath = d.transcript_path || '';
    if (!tpath || !fs.existsSync(tpath) || !fs.statSync(tpath).isFile()) return '';
    const dir = archiveDir(d, true);
    const name = `compact-${stampCompact(new Date())}.jsonl`;
    fs.copyFileSync(tpath, path.join(dir, name));
    pruneArchive(dir, 5);
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
    fs.writeFileSync(path.join(sessionDir(d, true), 'fallback.md'), md, 'utf8');
    return 'fallback.md';
  } catch (_) { return ''; }
}

// 복원 이중화: 압축 마커 남기기 / 소비하기(쓰면 즉시 삭제 → 안 쌓임)
function setRestoreMarker(d) {
  try {
    const tok = shortToken(d); if (!tok) return;
    fs.writeFileSync(path.join(sessionDir(d, true), 'restore-pending'),
      stampHuman(new Date()), 'utf8');
  } catch (_) {}
}
function consumeRestoreMarker(d) {
  try {
    const tok = shortToken(d); if (!tok) return false;
    const mk = path.join(sessionDir(d), 'restore-pending');
    if (fs.existsSync(mk)) { try { fs.unlinkSync(mk); } catch (_) {} return true; }
  } catch (_) {}
  return false;
}

// 이 세션 handoff 존재 여부(신 구조 .handoff/<세션>/handoff.md, 구 구조 .handoff/*-<토큰>.md).
// 모르면 안 건드림(true) — 넛지는 확실할 때만 띄운다.
function handoffExists(d) {
  try {
    const tok = shortToken(d); if (!tok) return true;
    // 프로젝트 루트를 모르면 판정하지 않는다 — 추측해서 "없다"고 넛지를 띄우면 오탐이 된다.
    if (!explicitRoot(d)) return true;
    const base = handoffDir(d);
    if (!fs.existsSync(base)) return false;
    if (fs.existsSync(path.join(sessionDir(d), 'handoff.md'))) return true;
    const suffix = `-${tok}.md`;
    return fs.readdirSync(base).some((f) => f.endsWith(suffix));
  } catch (_) { return true; }
}

// 이 세션의 큐레이션 handoff 파일 경로(신 구조 우선, 없으면 구 구조). 없으면 null.
function handoffFile(d) {
  try {
    const nf = path.join(sessionDir(d), 'handoff.md');
    if (fs.existsSync(nf)) return nf;
    const base = handoffDir(d), tok = shortToken(d);
    if (!tok || !fs.existsSync(base)) return null;
    const suffix = `-${tok}.md`;
    const leg = fs.readdirSync(base).find((f) => f.endsWith(suffix));
    return leg ? path.join(base, leg) : null;
  } catch (_) { return null; }
}

// 가장 최근 압축 백업(compact-*.jsonl)의 수정 시각(ms). 없으면 0.
function newestCompactMtime(d) {
  try {
    const dir = archiveDir(d);
    if (!fs.existsSync(dir)) return 0;
    let mx = 0;
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith('compact-') && f.endsWith('.jsonl')) {
        const mt = fs.statSync(path.join(dir, f)).mtimeMs;
        if (mt > mx) mx = mt;
      }
    }
    return mx;
  } catch (_) { return 0; }
}

// Stop 넛지 상태(턴 카운터). handoff 가 갱신되면 리셋되어 조용해진다.
function readStopState(d) {
  try { return JSON.parse(fs.readFileSync(path.join(sessionDir(d), 'stop-state'), 'utf8')); }
  catch (_) { return { hMtime: 0, turns: 0, nudgedTurn: -9999 }; }
}
function writeStopState(d, s) {
  try { fs.writeFileSync(path.join(sessionDir(d, true), 'stop-state'), JSON.stringify(s), 'utf8'); }
  catch (_) {}
}

// 마지막 handoff 이후 이만큼 답변 턴이 쌓이면 '낡음'으로 본다. 보수적 기본값(자주 안 뜨게).
// 압축이 발생하면 이 값과 무관하게 낡음으로 친다(세부가 요약으로 뭉개졌으므로).
const STALE_TURNS = 30;

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
  const dir = archiveDir(d, true);
  try {
    const name = `snap-${stampCompact(new Date())}.jsonl`;
    const dest = path.join(dir, name);
    fs.copyFileSync(tpath, dest);
    pruneSnapshots(dir, 3);
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

// ── distill 모드: 원본 jsonl → 메타데이터 걷어낸 '읽을 수 있는 전체 대화' ──
function countLines(p) {
  try { return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).length; } catch (_) { return -1; }
}

// 후보(라이브 원본 / 최신 아카이브) 중 '가장 완전한'(줄 수 많은) 것을 고른다.
// → "압축이 원본을 자르는가?" 라는 가정에 의존하지 않아 어느 쪽이든 안전하다.
function pickSource(args, tok) {
  if (args.source && fs.existsSync(args.source)) return args.source;
  const cands = [];
  const live = findTranscript(args.session || '');
  if (live && fs.existsSync(live)) cands.push(live);
  try {
    const dir = archiveDir({ cwd: args.cwd, session_id: args.session || '' });
    const f = fs.readdirSync(dir)
      .filter((x) => x.endsWith('.jsonl'))
      .sort().reverse()[0];
    if (f) cands.push(path.join(dir, f));
  } catch (_) {}
  if (!cands.length) return '';
  return cands.sort((a, b) => countLines(b) - countLines(a))[0];
}

// heredoc 본문(<<'EOF' … EOF)은 명령이 아니라 '파일 내용 덤프'다 — Write 의 content 와 같은 성격.
function stripHeredoc(cmd) {
  return String(cmd || '').replace(
    /(<<-?\s*'?"?([A-Za-z_][A-Za-z0-9_]*)'?"?\r?\n)([\s\S]*?)(\r?\n\2)/g,
    (_m, open, _tag, bodyText, close) => `${open}…(본문 ${bodyText.length}자 생략)${close}`
  );
}

// 도구 호출 인자 렌더링.
// 결과 덤프는 빼면서 인자 덤프(Edit 의 old/new_string, Write 의 content, Bash heredoc 본문)를
// 그대로 싣는 것은 일관성이 없다. 기본 모드는 '무엇에 무엇을 했는지'(대상)만 남기고 내용은 뺀다.
// full(무손실) 모드는 인자도 자르지 않는다.
function toolArgsText(b, limit) {
  const IN = (b && b.input) || {};
  const j = (v) => { try { return JSON.stringify(v); } catch (_) { return '{}'; } };
  if (limit < 0) return j(IN);                       // full = 무손실
  const keep = (o) => {
    const r = {};
    for (const k of Object.keys(o)) if (o[k] !== undefined && o[k] !== null && o[k] !== '') r[k] = o[k];
    return r;
  };
  const size = (v) => `${String(v == null ? '' : v).length}자`;
  switch (b.name) {
    case 'Read':
      return j(keep({ file_path: IN.file_path, offset: IN.offset, limit: IN.limit, pages: IN.pages }));
    case 'Write':
      return j(keep({ file_path: IN.file_path, '내용': size(IN.content) }));
    case 'Edit':
      return j(keep({ file_path: IN.file_path, '변경': `${size(IN.old_string)}→${size(IN.new_string)}`,
                      replace_all: IN.replace_all || undefined }));
    case 'NotebookEdit':
      return j(keep({ notebook_path: IN.notebook_path, cell_id: IN.cell_id, edit_mode: IN.edit_mode }));
    case 'Bash': case 'PowerShell':
      return j(keep({ command: stripHeredoc(IN.command), description: IN.description }));
    case 'Grep':
      return j(keep({ pattern: IN.pattern, path: IN.path, glob: IN.glob, type: IN.type, output_mode: IN.output_mode }));
    case 'Glob':
      return j(keep({ pattern: IN.pattern, path: IN.path }));
    case 'Agent': case 'Task':
      return j(keep({ description: IN.description, subagent_type: IN.subagent_type, '프롬프트': size(IN.prompt) }));
    case 'WebFetch': case 'WebSearch':
      return j(keep({ url: IN.url, query: IN.query }));
    case 'Workflow':
      return j(keep({ name: IN.name, scriptPath: IN.scriptPath, '스크립트': IN.script ? size(IN.script) : undefined }));
    case 'AskUserQuestion':
      return j(keep({ '질문': (IN.questions || []).map((q) => (q && (q.header || q.question)) || '') }));
    case 'Skill':
      return j(keep({ skill: IN.skill, args: IN.args }));
    default: {
      const s = j(IN);
      return s.length > 600 ? s.slice(0, 600) + ' …' : s;   // 미지의 도구는 종전대로 안전 상한
    }
  }
}

function parseTranscript(src) {
  const pad2 = (n) => String(n).padStart(2, '0');
  const hhmm = (ts) => { try { const d = new Date(ts); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; } catch (_) { return ''; } };
  const items = []; const kinds = new Set(); let nNoise = 0;
  const lines = fs.readFileSync(src, 'utf8').split('\n').filter(Boolean);
  for (const l of lines) {
    let o; try { o = JSON.parse(l); } catch (_) { continue; }
    const m = o.message || {}; const role = m.role || o.type; const t = hhmm(o.timestamp);
    const ts = Date.parse(o.timestamp) || 0;   // 증분(since) 필터용 epoch(ms)
    let c = m.content; if (typeof c === 'string') c = [{ type: 'text', text: c }];
    if (!Array.isArray(c)) continue;
    for (const b of c) {
      if (!b || typeof b !== 'object') continue;
      kinds.add(b.type);
      if (b.type === 'text') {
        let txt = String(b.text || '');
        // 사용자 메시지에 IDE/시스템이 끼워넣은 블록은 '사용자가 한 말'이 아니므로 제거한다.
        if (role === 'user') {
          const before = txt.length;
          txt = txt
            .replace(/<ide_opened_file>[\s\S]*?<\/ide_opened_file>/g, '')
            .replace(/<ide_selection>[\s\S]*?<\/ide_selection>/g, '')
            .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '');
          if (txt.length !== before) nNoise++;
        }
        txt = txt.trim();
        if (!txt) continue;   // 노이즈만 있던 메시지는 통째로 버린다
        items.push({ kind: 'text', role, t, ts, text: txt });
      } else if (b.type === 'thinking') {
        items.push({ kind: 'thinking', ts, text: String(b.thinking || '') });
      } else if (b.type === 'tool_use') {
        items.push({ kind: 'tool', ts, name: b.name, input: b.input || {} });
      } else if (b.type === 'tool_result') {
        let r = b.content;
        if (Array.isArray(r)) r = r.map((x) => (x && x.text) ? x.text : '').join('\n');
        items.push({ kind: 'result', ts, text: String(r ?? '').trim(), isError: !!b.is_error });
      } else if (b.type === 'image') {
        items.push({ kind: 'image', ts });
      }
    }
  }
  return { items, kinds, nNoise };
}

// 본문을 '줄 배열'로 만든다. 줄 배열이어야 도구 호출이 몇 번째 줄에 놓이는지 알 수 있고,
// 그 줄번호가 라이트/기본 정제본의 드릴다운 색인이 된다.
function renderBody(items, opts) {
  const L = []; const anchors = new Map();   // 파일명 → full 본문 기준 줄번호[]
  const st = { nU: 0, nA: 0, nT: 0, nR: 0, nTh: 0, nImg: 0 }; let idx = 0;
  const push = (s) => { for (const ln of String(s).split('\n')) L.push(ln); };
  const cut = (s, n) => { s = String(s ?? ''); return (n >= 0 && s.length > n) ? s.slice(0, n) + ' …(생략)' : s; };
  // delta: 발언은 이미 읽은 것으로 보고 싣지 않는다. 대신 위치를 알 수 있게
  // 뒤따르는 도구 블록 앞에 '발언 [N] 이후' 앵커를 한 번만 찍는다.
  let pending = 0;
  const anchorIfNeeded = () => {
    if (!opts.delta || !pending) return;
    push(''); push(`### ↳ 발언 [${pending}] 이후`);
    pending = 0;
  };
  for (const it of items) {
    // since(증분): 지정 시각 이전 항목은 본문을 싣지 않는다. 단 발언 번호 [N] 은
    // 전체본과 정합되게 계속 센다(드릴다운 앵커가 유효하도록). full 렌더는 sinceMs 가 없어 영향 없음.
    const skip = opts.sinceMs && it.ts && it.ts < opts.sinceMs;
    if (it.kind === 'text') {
      idx++;
      if (skip) continue;
      if (it.role === 'user') st.nU++; else st.nA++;
      if (opts.delta) { pending = idx; continue; }
      push(''); push(`## [${idx}] ${it.role === 'user' ? '사용자' : 'Claude'}  (${it.t})`); push(''); push(it.text);
    } else if (it.kind === 'thinking') {
      if (skip) continue;
      st.nTh++;
      if (opts.withThinking && it.text.trim()) {
        push(''); push('<details><summary>[사고과정]</summary>'); push(''); push(it.text.trim()); push('</details>');
      }
    } else if (it.kind === 'tool') {
      if (skip) continue;
      st.nT++;
      const p = it.input.file_path || it.input.notebook_path;
      if (p) {
        const bn = baseName(String(p));
        if (!anchors.has(bn)) anchors.set(bn, []);
        anchors.get(bn).push(L.length + 2);   // push('') 다음 줄에 도구 줄이 놓인다
      }
      if (!opts.lite) { anchorIfNeeded(); push(''); push(`**[도구] ${it.name}** — \`${toolArgsText(it, opts.limit)}\``); }
    } else if (it.kind === 'result') {
      if (skip) continue;
      st.nR++;
      if (!opts.lite) {
        anchorIfNeeded();
        const err = it.isError ? ' ⚠오류' : '';
        if (opts.limit === 0) {
          // 덤프 제외: 결과 본문은 싣지 않고 한 줄 미리보기만.
          const peek = it.text.slice(0, 200).replace(/\s+/g, ' ');
          push(''); push(`**[결과]${err}** ${peek}${it.text.length > 200 ? ' …' : ''}`);
        } else {
          const peek = it.text.slice(0, 80).replace(/\s+/g, ' ');
          push(''); push(`<details><summary>[결과]${err} ${peek}…</summary>`); push('');
          push('```'); push(cut(it.text, opts.limit)); push('```'); push('</details>');
        }
      }
    } else if (it.kind === 'image') {
      if (skip) continue;
      st.nImg++;
      if (!opts.lite) { anchorIfNeeded(); push(''); push('**[이미지 첨부]** (텍스트로 복원 불가)'); }
    }
  }
  return { lines: L, anchors, st, nSpeech: idx };
}

function doDistill(args) {
  const cwd = args.cwd || process.cwd();
  const tok = shortToken({ session_id: args.session || '' }) || 'nosid';
  const src = pickSource(args, tok);
  if (!src) {
    console.log('DISTILL FAILED: 대화 원본을 찾지 못했습니다. --session <uuid> 또는 --source <path> 를 지정하세요.');
    process.exitCode = 1; return;
  }
  // 모드는 셋. lite=발언만 / 기본=덤프 제외 / full=무손실.
  // 임의의 절단 길이(매직넘버)는 두지 않는다.
  const lite = String(args.lite || '') === 'on';
  const limit = args['tool-result'] === undefined ? 0 : parseInt(args['tool-result'], 10);
  const withThinking = String(args.thinking || '') === 'on';
  // delta: 발언은 이미 읽었다고 보고 '도구 블록만' 낸다. lite 를 읽은 뒤 normal/full 로
  // 올라갈 때 발언을 두 번 읽는 낭비를 없앤다.
  // lite 는 발언만 담는 모드라 delta 가 성립하지 않는다 — 조용히 무시하지 말고 알린다.
  const mode = lite ? 'lite' : (limit < 0 ? 'full' : 'normal');
  // since(증분): 마지막 handoff 이후만 낸다. `--since handoff` → handoff.md mtime, `--since <ms>` 도 가능.
  let sinceMs = 0, sinceLabel = '', sinceNote = '';
  if (args.since) {
    if (args.since === 'handoff') {
      const hf = handoffFile({ cwd, session_id: args.session || '' });
      if (hf) { sinceMs = fs.statSync(hf).mtimeMs; sinceLabel = 'handoff'; }
      else sinceNote = '\n※ 이 세션의 handoff.md 가 없어 since 기준을 못 잡아 전체를 냈습니다 — 먼저 /handoff 로 저장하세요.';
    } else {
      const n = parseInt(args.since, 10);
      if (!isNaN(n)) { sinceMs = n; sinceLabel = '지정 시각'; }
    }
  }
  const deltaAsked = String(args.delta || '') === 'on';
  const delta = deltaAsked && !lite && !sinceMs;
  const deltaNote = (deltaAsked && lite)
    ? '\n※ `lite` 는 발언만 담는 모드라 delta(=발언 제외)가 성립하지 않습니다. '
      + 'delta 를 무시하고 lite 로 생성했습니다. 도구 내역이 필요하면 `normal delta` 를 쓰세요.'
    : ((deltaAsked && sinceMs) ? '\n※ since 와 delta 는 함께 쓰지 않습니다 — since(증분)로 생성했습니다.' : '');

  const { items, kinds, nNoise } = parseTranscript(src);
  const srcMB = (fs.statSync(src).size / 1048576).toFixed(2);
  const stamp = new Date(fs.statSync(src).mtime).toISOString().slice(0, 16).replace('T', ' ');

  // full 은 어떤 모드로 돌리든 항상 만든다 — 드릴다운 창고이자 줄번호의 기준이다.
  // 같은 실행에서 함께 생성하므로 색인의 줄번호가 어긋날 수 없다.
  const full = renderBody(items, { limit: -1, withThinking, lite: false });

  const mkHead = (m, extra, stx) => {
    const s = stx || full.st;
    const desc = {
      lite: ['**발언만** (도구 블록 제외)', '—', '—'],
      normal: ['발언 전문 + 도구 요약', '**덤프 제외** (한 줄 미리보기는 보존)', '**대상만** (경로·명령·패턴 등)'],
      full: ['**무손실**', '**전문 보존**(접기로 삽입)', '**전문 보존**'],
    }[m];
    const isDelta = delta && m === mode;
    const isSince = sinceMs && m === mode;
    const sinceHuman = sinceMs ? new Date(sinceMs).toISOString().slice(0, 16).replace('T', ' ') : '';
    return `# 전체 대화 복원본 (정제·${m}${isDelta ? '·delta' : ''}${isSince ? '·since' : ''}) — ${tok}

${isDelta
  ? `> **차이분(delta)이다.** 발언(사용자·Claude)은 **이미 읽은 것으로 보고 생략**했고, 도구 블록만 담았다.\n`
    + `> 각 블록 앞의 \`### ↳ 발언 [N] 이후\` 가 위치를 알려준다 — 발언 번호는 모든 모드에서 동일하다.`
  : (isSince
    ? `> **증분(since)이다.** 마지막 handoff 이후만 담았고 그 이전은 생략했다.\n`
      + `> 발언 번호 [N] 은 전체본과 동일하게 유지된다 — 그 이전이 궁금하면 \`restore/restore-full.md\` 의 같은 번호를 본다.`
    : `> **요약본이 아니다.** 주고받은 **전체 대화**에서 메타데이터(uuid/usage/requestId/cache 등)만 걷어낸 것이다.\n`
      + `> **사용자·Claude 발언은 어떤 모드에서도 전문 보존.** 이미지는 텍스트로 복원 불가라 표시만 남긴다.`)}

- 원본: \`${path.basename(src)}\` (${srcMB} MB, ${stamp})${src.includes('.archive') ? ' — 아카이브' : ' — 라이브 원본(가장 완전)'}
- 모드: ${isDelta ? `**차이분(delta)** — 도구 블록만, 발언 제외 (\`${m}\` 기준)` : (isSince ? `**증분(since)** — 마지막 ${sinceLabel}(${sinceHuman}) 이후만 (\`${m}\` 기준)` : desc[0])}
- 메시지: 사용자 ${s.nU} · Claude ${s.nA} · 도구호출 ${s.nT} · 도구결과 ${s.nR}${s.nImg ? ` · 이미지 ${s.nImg}` : ''}${isSince ? ' (이 발췌 기준)' : ''}
- 도구 결과: ${desc[1]}
- 도구 호출 인자: ${desc[2]}
- 사고과정 블록 ${s.nTh}개: ${withThinking ? '포함' : '제외(--thinking on 으로 포함 가능)'}
- IDE/시스템 주입 노이즈 제거: ${nNoise}건 (\`<ide_opened_file>\`, \`<ide_selection>\`, \`<system-reminder>\`)
- 블록종류: ${[...kinds].join(', ')}
${extra || ''}
---
`;
  };

  const fullHead = mkHead('full');
  const fullOffset = fullHead.split('\n').length - 1;   // 본문 첫 줄이 놓이는 위치
  const fullText = fullHead + full.lines.join('\n');
  const sctx = { cwd, session_id: args.session || '' };
  const rdir = restoreDir(sctx, true);
  const fullPath = path.join(rdir, 'restore-full.md');

  // 드릴다운 색인: 건드린 파일 → full 정제본의 줄번호. grep 없이 바로 그 줄로 점프한다.
  let index = '';
  if ((mode !== 'full' || delta || sinceMs) && full.anchors.size) {
    const rows = [...full.anchors.entries()]
      .map(([f, ls]) => `  - \`${f}\` — ${ls.map((n) => n + fullOffset).join(', ')}`)
      .sort();
    index = `\n### 드릴다운 색인 — 건드린 파일 ${full.anchors.size}개\n\n`
      + `숫자는 같은 폴더의 \`restore/restore-full.md\`(무손실본, 같은 실행에서 함께 생성됨)의 **줄번호**다.\n`
      + `자세한 내역이 필요하면 그 줄 전후를 \`Read(offset/limit)\` 으로 읽는다. 통째로 읽지 않는다.\n\n`
      + rows.join('\n') + '\n';
  }

  const asIs = mode === 'full' && !delta && !sinceMs;   // full 원본 그대로면 재렌더 불필요(단 since 면 걸러야 함)
  const modeRender = asIs ? full : renderBody(items, { limit, withThinking, lite, delta, sinceMs });
  const modeText = asIs ? fullText : (mkHead(mode, index, modeRender.st) + modeRender.lines.join('\n'));
  const modePath = args.out || (asIs ? fullPath
    : path.join(rdir, `restore-${mode}${delta ? '-delta' : ''}${sinceMs ? '-since' : ''}.md`));

  try {
    fs.writeFileSync(fullPath, fullText, 'utf8');                     // 항상 갱신(덮어쓰기)
    if (modePath !== fullPath) fs.writeFileSync(modePath, modeText, 'utf8');
    const mb = (s) => (Buffer.byteLength(s, 'utf8') / 1048576).toFixed(2);
    logEvent('distill', { cwd, session_id: args.session || '' },
      `mode:${mode}${delta ? '-delta' : ''}${sinceMs ? '-since' : ''} out:${path.basename(modePath)} ${srcMB}MB->${mb(modeText)}MB`);
    console.log(`DISTILL OK (${mode}${delta ? ' · delta' : ''}${sinceMs ? ' · since' : ''})
- 원본     : ${src} (${srcMB} MB)
- 읽을 것  : ${modePath} (${mb(modeText)} MB, ${modeText.split('\n').length}줄)
- 드릴다운 : ${fullPath} (${mb(fullText)} MB, ${fullText.split('\n').length}줄) — 항상 갱신됨. 필요한 줄만 읽는다
- 메시지   : 사용자 ${full.st.nU} · Claude ${full.st.nA} · 도구호출 ${full.st.nT} · 도구결과 ${full.st.nR}${full.st.nImg ? ` · 이미지 ${full.st.nImg}` : ''}
→ [읽을 것]을 Read 하면 전체 대화가 맥락으로 복귀한다.${deltaNote}${sinceNote}`);
  } catch (e) {
    console.log('DISTILL FAILED:', String(e && e.message ? e.message : e));
    process.exitCode = 1;
  }
}

// ── update-plugin 모드 ───────────────────────────────────────────
// 마켓 클론 git pull → 최신 버전을 캐시에 설치 → installed_plugins.json 갱신.
// 표준 `/plugin update` 를 쓸 수 없는 실행 컨텍스트(Agent SDK 등)를 위한 대체 수단.
function pluginsRoot() { return path.join(os.homedir(), '.claude', 'plugins'); }
function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeJsonBackup(p, obj) {
  try { if (fs.existsSync(p)) fs.copyFileSync(p, p + '.bak'); } catch (_) {}
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}
function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name === '.git') continue;
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  }
}
function git(loc, ...a) {
  return execFileSync('git', ['-C', loc, ...a], { encoding: 'utf8' }).trim();
}

function doPluginUpdate(args) {
  const mkt = args.marketplace || 'd124412-plugins';
  const plug = args.plugin || 'session-handoff';
  const key = `${plug}@${mkt}`;
  const root = pluginsRoot();
  try {
    const km = readJson(path.join(root, 'known_marketplaces.json'));
    if (!km[mkt]) {
      console.log(`UPDATE-PLUGIN FAILED: 마켓플레이스 '${mkt}' 가 등록돼 있지 않습니다.`);
      process.exitCode = 1; return;
    }
    const loc = km[mkt].installLocation;
    let pulled = '(pull 생략)';
    try { pulled = git(loc, 'pull', '--ff-only').split('\n').pop(); }
    catch (e) { pulled = '⚠ pull 실패: ' + String(e && e.message ? e.message : e).split('\n')[0]; }

    const srcDir = path.join(loc, 'plugins', plug);
    const newVer = readJson(path.join(srcDir, '.claude-plugin', 'plugin.json')).version;

    const ipPath = path.join(root, 'installed_plugins.json');
    const ip = readJson(ipPath);
    ip.plugins = ip.plugins || {};
    const cur = (ip.plugins[key] || [])[0] || null;
    if (cur && cur.version === newVer) {
      console.log(`UPDATE-PLUGIN: 이미 최신입니다 (v${newVer}).  ${pulled}`);
      return;
    }
    const dst = path.join(root, 'cache', mkt, plug, newVer);
    copyDir(srcDir, dst);
    let sha = ''; try { sha = git(loc, 'rev-parse', 'HEAD'); } catch (_) {}
    const now = new Date().toISOString();
    ip.plugins[key] = [{
      scope: (cur && cur.scope) || 'user',
      installPath: dst,
      version: newVer,
      installedAt: (cur && cur.installedAt) || now,
      lastUpdated: now,
      gitCommitSha: sha || (cur && cur.gitCommitSha) || '',
    }];
    writeJsonBackup(ipPath, ip);
    logEvent('update-plugin', { cwd: args.cwd || process.cwd() },
      `${cur ? cur.version : 'none'}->${newVer}`);
    console.log(`UPDATE-PLUGIN OK
- 대상      : ${key}
- 버전      : ${cur ? 'v' + cur.version : '(미설치)'} → v${newVer}
- 설치 경로 : ${dst}
- 마켓 pull : ${pulled}
- 백업      : installed_plugins.json.bak
→ Claude Code 를 재시작해야 적용됩니다.`);
  } catch (e) {
    console.log('UPDATE-PLUGIN FAILED:', String(e && e.message ? e.message : e));
    process.exitCode = 1;
  }
}

// ── version 모드 ─────────────────────────────────────────────────
// 자기 자신(이 스크립트) 옆의 plugin.json 을 읽는다. 수동으로 버전 문자열을
// 박아둘 필요가 없고, "지금 실행 중인 그 설치본"의 버전이 정확히 나온다.
const HERE = path.dirname(fileURLToPath(import.meta.url));
function selfVersion() {
  try {
    const pj = path.join(HERE, '..', '.claude-plugin', 'plugin.json');
    return JSON.parse(fs.readFileSync(pj, 'utf8')).version || '';
  } catch (_) { return ''; }
}

// 세션 시작 리마인더에 붙일 한 줄. 이 값이 곧 '이 세션이 로드한 버전'이다.
function versionLine() {
  const v = selfVersion();
  return v ? `\n■ session-handoff v${v} 로드됨 (버전/최신 여부 확인: /version)` : '';
}

function doVersion(args) {
  const mkt = args.marketplace || 'd124412-plugins';
  const plug = args.plugin || 'session-handoff';
  const key = `${plug}@${mkt}`;
  const root = pluginsRoot();
  const running = selfVersion();
  let installed = '', market = '';
  try {
    const ip = readJson(path.join(root, 'installed_plugins.json'));
    installed = (((ip.plugins || {})[key] || [])[0] || {}).version || '';
  } catch (_) {}
  try {
    const km = readJson(path.join(root, 'known_marketplaces.json'));
    const loc = km[mkt] && km[mkt].installLocation;
    if (loc) {
      try { git(loc, 'fetch', '--quiet', 'origin', 'main'); } catch (_) {}
      try {
        const raw = git(loc, 'show', `origin/main:plugins/${plug}/.claude-plugin/plugin.json`);
        market = JSON.parse(raw).version || '';
      } catch (_) {}
      if (!market) {
        try {
          market = readJson(path.join(loc, 'plugins', plug, '.claude-plugin', 'plugin.json')).version || '';
        } catch (_) {}
      }
    }
  } catch (_) {}

  const todo = [];
  if (market && installed && market !== installed) {
    todo.push(`• 설치본이 구버전입니다 → /update-plugin 실행 (v${installed} → v${market})`);
  }
  todo.push('• 세션 시작 때 주입된 "session-handoff vX 로드됨" 과 위 [설치됨] 을 비교하세요. '
    + '다르면 Claude Code 재시작이 필요합니다(명령문은 세션 시작 시 1회만 로드됨).');

  console.log(`SESSION-HANDOFF VERSION
- 실행 중(스크립트) : ${running ? 'v' + running : '(알 수 없음)'}
- 설치됨(디스크)    : ${installed ? 'v' + installed : '(미설치)'}
- 마켓 최신(원격)   : ${market ? 'v' + market : '(조회 실패)'}

${todo.join('\n')}`);
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
    return `\n■ 이번 세션 고유 토큰: \`${tok}\`  → 내 세션 폴더는 \`.handoff/*-${tok}/\` 이고 `
         + `큐레이션 핸드오프는 그 안의 \`handoff.md\` 다. 이 토큰으로 내 폴더를 찾아 소유권을 확정한 뒤 이어가라.`
         + `\n■ 압축 직전 대화 원본이 \`.handoff/*-${tok}/archive/compact-*.jsonl\` 로 자동 백업돼 있다.`
         + `\n■ 빠른 복원용 뼈대 요약이 같은 폴더의 \`fallback.md\` 에 있다(무LLM 규칙추출). `
         + `전체 대화가 필요하면 \`/restore\` 를 쓴다(원본 .jsonl 을 직접 읽거나 grep 하지 말 것 — 한 줄이 수만 자다).`;
  }
  return '';
}

function restoreMsg(tok) {
  return `[세션 인수인계 — 압축 복원 재확인] 직전에 컨텍스트 압축이 있었다. 아직 맥락을 복원하지 않았다면 지금:\n`
       + `1) .handoff/INDEX.md 와 내 세션 폴더 .handoff/*-${tok}/handoff.md 를 읽는다.\n`
       + `2) 세부가 필요하면 같은 폴더의 fallback.md(뼈대 요약)를 읽거나 /restore 로 전체 대화를 되살린다.\n`
       + `3) 요약을 맹신하지 말고 실제 소스 파일을 다시 열어 확인하라. (이미 복원했다면 무시.)`;
}

function migrateLine(done) {
  return done
    ? '\n■ 구 평면 구조(.handoff/.archive/<토큰>-*)를 내 세션 폴더로 **이관**했다(복사, 원본은 남겨둠). '
      + '이제 이 세션 것은 `.handoff/<주제>-<토큰>/` 안에 있다.'
    : '';
}

function stopNudge(tok) {
  return `[세션 인수인계] 이 세션의 handoff(.handoff/<주제>-${tok}/handoff.md)가 아직 없다. `
       + `의미 있는 작업을 했다면 /handoff 로 현재 상태를 남겨두면 다음 세션(또는 압축 후)이 이어갈 수 있다.`;
}
function staleNudge(tok, compacted) {
  return `[세션 인수인계] 이 세션의 handoff(.handoff/<주제>-${tok}/handoff.md)가 최근 작업을 안 담고 있을 수 있다`
       + (compacted ? '(마지막 갱신 뒤 압축이 있었다). ' : '(마지막 갱신 뒤 작업이 꽤 쌓였다). ')
       + `이어가기에 중요한 결정·진행이 있었다면 /handoff 로 갱신을 고려하라. (아니면 무시)`;
}

// Stop: ① handoff 가 없으면 만들라고, ② 있는데 낡았으면(압축 발생 / 장기 미갱신) 갱신하라고
// 부드럽게 상기한다. 둘 다 트리거당 1회(쿨다운)라 성가시지 않다. 루트를 모르면 판정하지 않는다.
function handleStop(d, tok) {
  if (!tok || !explicitRoot(d)) return;                 // 루트 모르면 추측하지 않는다
  const hfile = handoffFile(d);
  if (!hfile) { emit('Stop', stopNudge(tok)); return; } // 없음 → 만들라고
  let hMtime = 0; try { hMtime = fs.statSync(hfile).mtimeMs; } catch (_) {}
  const st = readStopState(d);
  // handoff 가 마지막으로 본 것보다 새로 갱신됐으면 카운터 리셋 → 조용해진다.
  if (hMtime > (st.hMtime || 0)) { writeStopState(d, { hMtime, turns: 0, nudgedTurn: -9999 }); return; }
  st.turns = (st.turns || 0) + 1;
  const compacted = newestCompactMtime(d) > hMtime;     // 마지막 handoff 뒤 압축 발생?
  const stale = compacted || st.turns >= STALE_TURNS;
  const dueAgain = (st.turns - (st.nudgedTurn ?? -9999)) >= STALE_TURNS;  // 트리거당 1회
  if (stale && dueAgain) { st.nudgedTurn = st.turns; writeStopState(d, st); emit('Stop', staleNudge(tok, compacted)); return; }
  writeStopState(d, st);
}

function main() {
  const mode = process.argv[2] || 'start';

  if (mode === 'snapshot') { doSnapshot(parseArgs(process.argv)); return; }
  if (mode === 'distill') { doDistill(parseArgs(process.argv)); return; }
  if (mode === 'update-plugin') { doPluginUpdate(parseArgs(process.argv)); return; }
  if (mode === 'version') { doVersion(parseArgs(process.argv)); return; }

  const data = readInput();
  const tok = shortToken(data);
  if (mode === 'compact') {
    const m = migrateIfNeeded(data);
    emit('SessionStart', COMPACT_MSG + tokenLineCompact(tok) + versionLine() + migrateLine(m));
  } else if (mode === 'start') {
    const m = migrateIfNeeded(data);
    emit('SessionStart', START_MSG + tokenLineStart(tok) + versionLine() + migrateLine(m));
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
    handleStop(data, tok);
  }
  // 알 수 없는 모드는 조용히 무시
}

main();
