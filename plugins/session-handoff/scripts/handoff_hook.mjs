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
    const dir = archiveDir({ cwd: args.cwd || process.cwd() });
    const f = fs.readdirSync(dir)
      .filter((x) => x.startsWith(tok + '-') && x.endsWith('.jsonl'))
      .sort().reverse()[0];
    if (f) cands.push(path.join(dir, f));
  } catch (_) {}
  if (!cands.length) return '';
  return cands.sort((a, b) => countLines(b) - countLines(a))[0];
}

function doDistill(args) {
  const cwd = args.cwd || process.cwd();
  const tok = shortToken({ session_id: args.session || '' }) || 'nosid';
  const src = pickSource(args, tok);
  if (!src) {
    console.log('DISTILL FAILED: 대화 원본을 찾지 못했습니다. --session <uuid> 또는 --source <path> 를 지정하세요.');
    process.exitCode = 1; return;
  }
  // 기본은 도구 결과 '덤프 제외'(0). 임의의 절단 길이를 정하지 않는다 —
  // 덤프는 파일 내용·명령 출력이라 디스크에서 다시 읽으면 되고, 원본 콘텐츠의 ~67% 를 차지한다.
  // 제외해도 도구 이름·인자·결과 한 줄 미리보기는 남으므로 '무엇을 했는지'는 보존된다.
  // 발언(사용자/Claude)은 어떤 경우에도 전문 보존. 무손실이 필요하면 -1 (= /restore full).
  const limit = args['tool-result'] === undefined ? 0 : parseInt(args['tool-result'], 10);
  const withThinking = String(args.thinking || '') === 'on';
  const pad2 = (n) => String(n).padStart(2, '0');
  const hhmm = (ts) => { try { const d = new Date(ts); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; } catch (_) { return ''; } };
  const cut = (s, n) => { s = String(s ?? ''); return (n >= 0 && s.length > n) ? s.slice(0, n) + ' …(생략)' : s; };

  const body = []; const kinds = new Set();
  let nU = 0, nA = 0, nT = 0, nR = 0, nTh = 0, nImg = 0, nNoise = 0, i = 0;
  const lines = fs.readFileSync(src, 'utf8').split('\n').filter(Boolean);
  for (const l of lines) {
    let o; try { o = JSON.parse(l); } catch (_) { continue; }
    const m = o.message || {}; const role = m.role || o.type; const t = hhmm(o.timestamp);
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
        i++;
        const who = role === 'user' ? '사용자' : 'Claude';
        if (role === 'user') nU++; else nA++;
        body.push(`\n## [${i}] ${who}  (${t})\n\n${txt}`);
      } else if (b.type === 'thinking') {
        nTh++;
        if (withThinking && String(b.thinking || '').trim()) {
          body.push(`\n<details><summary>[사고과정]</summary>\n\n${String(b.thinking).trim()}\n</details>`);
        }
      } else if (b.type === 'tool_use') {
        let inp = ''; try { inp = JSON.stringify(b.input ?? {}); } catch (_) {}
        if (inp.length > 600) inp = inp.slice(0, 600) + ' …';
        body.push(`\n**[도구] ${b.name}** — \`${inp}\``); nT++;
      } else if (b.type === 'tool_result') {
        let r = b.content;
        if (Array.isArray(r)) r = r.map((x) => (x && x.text) ? x.text : '').join('\n');
        r = String(r ?? '').trim();
        const err = b.is_error ? ' ⚠오류' : '';
        if (limit === 0) {
          // 덤프 제외 모드: 결과 본문은 싣지 않고 한 줄 미리보기만 남긴다.
          const peek = r.slice(0, 200).replace(/\s+/g, ' ');
          body.push(`\n**[결과]${err}** ${peek}${r.length > 200 ? ' …' : ''}`);
        } else {
          const peek = r.slice(0, 80).replace(/\s+/g, ' ');
          body.push(`\n<details><summary>[결과]${err} ${peek}…</summary>\n\n\`\`\`\n${cut(r, limit)}\n\`\`\`\n</details>`);
        }
        nR++;
      } else if (b.type === 'image') {
        nImg++; body.push(`\n**[이미지 첨부]** (텍스트로 복원 불가)`);
      }
    }
  }
  const srcMB = (fs.statSync(src).size / 1048576).toFixed(2);
  const head = `# 전체 대화 복원본 (정제) — ${tok}

> **요약본이 아니다.** 주고받은 **전체 대화**에서 메타데이터(uuid/usage/requestId/cache 등)만 걷어낸 것이다.
> 도구 결과는 접기(details)로 전문 보존. 이미지는 텍스트로 복원 불가라 표시만 남긴다.

- 원본: \`${path.basename(src)}\` (${srcMB} MB)${src.includes('.archive') ? ' — 아카이브' : ' — 라이브 원본(가장 완전)'}
- 메시지: 사용자 ${nU} · Claude ${nA} · 도구호출 ${nT} · 도구결과 ${nR}${nImg ? ` · 이미지 ${nImg}` : ''}
- 도구 결과: ${limit === 0 ? '**덤프 제외** (도구명·인자·한 줄 미리보기는 보존)' : limit < 0 ? '**전문 보존**(무손실)' : `${limit}자 절단`}
- 사고과정 블록 ${nTh}개: ${withThinking ? '포함' : '제외(--thinking on 으로 포함 가능)'}
- IDE/시스템 주입 노이즈 제거: ${nNoise}건 (\`<ide_opened_file>\`, \`<ide_selection>\`, \`<system-reminder>\`)
- 블록종류: ${[...kinds].join(', ')}

---
`;
  const text = head + body.join('\n');
  const out = args.out || path.join(archiveDir({ cwd }), `${tok}-full.md`);
  try {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, text, 'utf8');
    const outMB = (Buffer.byteLength(text, 'utf8') / 1048576).toFixed(2);
    logEvent('distill', { cwd, session_id: args.session || '' }, `out:${path.basename(out)} ${srcMB}MB->${outMB}MB`);
    console.log(`DISTILL OK
- 원본     : ${src} (${srcMB} MB)
- 정제본   : ${out} (${outMB} MB)
- 메시지   : 사용자 ${nU} · Claude ${nA} · 도구 ${nT}/${nR}${nImg ? ` · 이미지 ${nImg}` : ''}
→ 이 정제본을 Read 하면 전체 대화가 맥락으로 복귀한다.`);
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
  if (mode === 'distill') { doDistill(parseArgs(process.argv)); return; }
  if (mode === 'update-plugin') { doPluginUpdate(parseArgs(process.argv)); return; }

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
