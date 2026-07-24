# Prior Art / Benchmark — session-handoff

> 조사일 2026-07-25. GitHub 스타 수는 그날 API 기준(매일 변동). 1차 출처(repo/공식문서) 우선.

## 0. 결론 (Bottom line)

우리 플러그인은 **의외로 비어 있는 니치** — *압축 순간 생존 + 한 repo 동시 멀티세션 핸드오프* — 를 차지한다. 88k★ 플래그십(claude-mem)조차 `SessionEnd`만 훅(중간 자동압축이 사각), 공식 Remember 플러그인도 `PreCompact` 없음. **주제+UUID토큰 파일 소유권 + INDEX 조율**은 조사한 도구 중 유일해 보인다. 단, *단일 세션 압축 대응* 축에서는 compact-plus/compact-ops가 성숙한 피어이고, *요약을 실제로 쓰게 강제*하는 신뢰성 면에서는 thepushkarp에 뒤진다.

## 1. 가장 가까운 Claude Code 사례 (로직 위주)

### Tier 1 — 압축/핸드오프 훅 플러그인 (직접 비교군)
- **REMvisual/claude-handoff** (36★) — 가장 가까운 아날로그. `/handoff` 스킬 + PreCompact 안전망. transcript 복사 대신 **12항목 체크리스트로 대화 마이닝**(500K+ 토큰이면 map-reduce). 워크스트림별 md + **체인 시퀀싱(seq 1→2→3)**. 원본 백업/동시성 없음.
- **u-ichi/compact-plus** (175★) — *압축 메커니즘상 우리 최근접 피어.* PreCompact에서 transcript 백업 + **10섹션 상태파일 LLM 생성**(Sonnet, Haiku 가능), 압축 후 상태+플랜+**"원본 다시 읽어라" 리마인더** 재주입. 임계치에서 `/compact` 유도 + 마지막 턴에 3줄 암송. Claude Code+Codex 양용.
- **kenimo49/compact-ops** (2★, compact-plus 후속) — PreCompact + **PostCompact** + SessionStart. 10섹션(**"실패한 시도"** + **"워커 토폴로지"**), Sonnet→Haiku, transcript **gzip** 백업(30일/20개).
- **who96/claude-code-context-handoff** (2★) — **무LLM 규칙 추출**(최근 15 유저메시지 dedup 85% + 최근 10 어시스턴트 스니펫). 세션별 파일, latest-handoff 폴백(cwd+max-age).
- **thepushkarp/handoff** (7★) — 단일 공유 HANDOFF.md에 append. **Stop 훅이 요약(8-12 bullets) 채울 때까지 종료 차단(최대 3회 재시도)** ← 우리에게 없는 강제 메커니즘.
- **Sonovore/claude-code-handoff** (11★) — UserPromptSubmit+PostToolUse로 **상시** session-state.md 유지 + 수동 /handoff 모드.

### Tier 2 — 무거운 메모리/"brain" 시스템 (PreCompact도 훅)
- **coleam00/claude-memory-compiler** (1,255★, Cole Medin) — SessionEnd+PreCompact가 **백그라운드 프로세스**로 Agent SDK 호출해 저장 결정 → daily md → 지식 컴파일 → SessionStart 재주입. **벡터DB 없이 순수 마크다운.** *우리 v1.1.0 자동요약의 최명확 선례.*
- **yuvalsuede/memory-mcp** (97★) — Stop/PreCompact/SessionEnd에서 **Haiku**로 추출. state.json + 자동 CLAUDE.md(150줄) + Jaccard dedup + 7일 decay.
- **mikeadolan/claude-brain** (28★) — **가장 순수한 원본 백업**: PreCompact가 **모든 메시지를 SQLite**에 저장, PostCompact가 DB 검색해 주입. ~1GB/1300세션, 무LLM.
- **thedotmack/claude-mem** (~88,448★ 🚩사람 확인 요망) — 5개 훅 + **SQLite(FTS5)+Chroma 벡터** 하이브리드 검색. **SessionEnd만 캡처 → 중간 자동압축이 정확히 사각.**
- **Digital-Process-Tools/claude-remember** = 공식 마켓 **"Remember"** (140★, **~48,132 설치**) — SessionStart+UserPromptSubmit+PostToolUse(**PreCompact 없음**). **티어 Haiku 압축**(now→today→recent→archive) + remember.md 핸드오프. **락파일+쿨다운으로 동시성** 처리.

### Tier 3 — 멀티세션/팀 조율 (우리 차별점의 이웃)
- **hex/claude-sessions** (30★) — 가장 강한 멀티세션 설계. 세션별 디렉터리 + git shadow-ref 크래시복구 + **컨텍스트 차면 새 대화로 회전**하며 핸드오프 기록.
- **GWUDCAP/cc-sessions** (1,551★) — 태스크=frontmatter md, 5개 서브에이전트가 별도 컨텍스트로 transcript 흡수 + **"컨텍스트 압축" 프로토콜 템플릿**.
- **ingram/ccgs** (14★) — **서버 없는 팀 공유**: verbatim .jsonl + memory md를 **orphan git 브랜치**에 push.
- **DazzleML/Claude-Session-Backup** (5★) — PreCompact+SessionEnd → **git 백업** 원본 .jsonl + 복원 UI.

## 2. 비교표

범례: ✅ 예 · ⚠️ 부분 · ❌ 아니오

| 방식 | 압축 생존 | 멀티세션 동시성 | 원본 백업 | 자동요약(모델) | 큐레이션 메모리 | 배포 |
|---|---|---|---|---|---|---|
| **OURS** | ✅ SessionStart(compact) 재주입 + PreCompact 아카이브 | ✅✅ **파일/세션 + 주제+UUID토큰 + INDEX** | ✅ .jsonl 복사(최신5) | ⚠️ v1.1.0 실험 Haiku(type:agent) | ✅ 세션별 1 md | 플러그인(마켓/git) |
| REMvisual/claude-handoff | ✅ 안전망+스킬 | ❌ 체인=순차 | ❌(마이닝) | ✅ 체크리스트 마이닝 | ✅ 체인시퀀스 | 플러그인 |
| u-ichi/compact-plus | ✅ | ❌ 단일공유 | ✅ | ✅ Sonnet | ✅ 10섹션 | 플러그인(CC+Codex) |
| kenimo49/compact-ops | ✅ Pre+Post | ⚠️ | ✅ gzip | ✅ Sonnet→Haiku | ✅ 10섹션 | 플러그인 |
| who96 | ✅ | ⚠️ | ❌ | ❌ **규칙** | ⚠️ | 플러그인 |
| thepushkarp | ✅ | ❌ 단일 | ❌ | ⚠️ **Stop훅 강제** | ✅ append | 플러그인 |
| coleam00/memory-compiler | ✅ | ❌ | ❌ | ✅ **Agent SDK** | ✅ daily→지식 | git |
| mikeadolan/claude-brain | ✅ Pre+Post | ❌ | ✅✅ **verbatim→SQLite** | ❌(검색) | ❌(DB) | 플러그인+MCP |
| thedotmack/claude-mem(88k) | ⚠️ **SessionEnd만** | ❌ | ❌ | ✅ 시맨틱 | ✅(검색) | 플러그인(SQLite+Chroma) |
| 공식 Remember | ⚠️ SessionStart만 | ✅ **락파일** | ❌ | ✅ **티어 Haiku** | ✅ remember.md | 공식 마켓 |
| hex/claude-sessions | ✅ **회전** | ✅✅ 세션디렉+shadow-ref | ⚠️ | ⚠️ /sweep | ✅ | 설치기+훅 |
| **CC 네이티브**(CLAUDE.md+MEMORY.md) | ✅ **압축후 디스크서 재주입** | ❌ 단일파일 | ✅ .jsonl(resume,30일) | ✅ **MEMORY.md 자동작성** | ✅ | 내장 |
| Cline/Roo Memory Bank | ⚠️ 프롬프트 | ❌ | ❌ | ❌ 수동 | ✅ 구조 md | 커스텀지시 |
| Cursor/Windsurf memories | ✅ 관련도 | ❌ | ❌ | ✅ **자동생성** | ✅+Rules | IDE 내장 |
| mem0/MCP memory | ❌ 압축 무관 | ⚠️ | ❌ | ✅ LLM 사실추출 | ⚠️ | lib+MCP |

## 3. 인접 도구 로직
- **Cline Memory Bank**: `memory-bank/` 6개 구조 md(의존 그래프) + **"매 태스크 시작 시 다 읽어라" 강한 프롬프트**. 코드/DB/훅 없음. 갱신 수동("update memory bank"). 신뢰성=모델 순종.
- **Roo Code Memory Bank** (1,677★): 모드별 YAML 전략 + `[MEMORY BANK: ACTIVE]` 상태접두 + UMB 수동갱신. 후속 RooFlow(1,225★).
- **Aider**: `.aider.chat.history.md` 자동기록이나 **--restore-chat-history 없으면 미사용**. `--weak-model`로 오래된 턴 **롤링 요약**(최근 tail verbatim). 핵심 혁신은 **repo map**(tree-sitter AST+PageRank, ~1k토큰).
- **Cursor**: Rules(.cursor/rules/*.mdc, 4활성화) + Memories(베타, **채팅서 자동생성**, 프로젝트별).
- **Windsurf/Cascade**: **대화 중 자동 memory 생성**(무료), `~/.codeium/windsurf/memories/` 로컬 저장, 미커밋.
- **MCP memory**: 공식 KG(엔티티/관계/관찰 JSONL, **substring 검색**, 수동 툴콜, **동시성 위험**=전체 재기록). **mem0**(61.6k★): LLM이 사실추출 후 ADD/UPDATE/DELETE/NOOP 결정(Qdrant 벡터). **압축 이벤트/멀티세션 동시성은 아무도 타겟 안 함** — 확인된 갭.

## 4. Claude Code 네이티브 (중복 주의)
- **CLAUDE.md + auto-memory MEMORY.md**(클로드가 자동 작성, 200줄/25KB 로드, **압축 후 디스크서 재주입**). ← **우리 큐레이션 요약과 최대 중복.** 협력할지/왜 분리할지 명시 필요.
- 압축은 구조 요약(요청/개념/파일+스니펫/에러+수정/대기작업/현재작업) 유지. 자동압축 ~95%(커뮤니티 소스).
- resume/continue/fork from .jsonl(30일). 세션 UUID = 우리 토큰 출처.
- 훅 SessionStart 매처 = 정확히 `startup,resume,clear,compact,fork`(우리 설정 맞음). PreCompact(manual/auto, block 가능, custom_instructions 받음). **PostCompact**(압축 후, 주입 불가 side-effect).

**우리가 보완(중복 아님)**: ① 멀티세션 동시성, ② 압축순간 무손실 원본 백업, ③ SessionStart(compact) 복원 리마인더.
**중복 위험**: 큐레이션 요약이 네이티브 MEMORY.md와 상당 겹침.

## 5. 벤치마크 판정
**훔칠 아이디어(THEY>US)**: 요약 실제 작성 강제(thepushkarp Stop훅) / "원본 재읽기" 리마인더(compact-plus,ops) / 무LLM 결정론 폴백(who96) / 풍부한 스키마(실패한시도, 워커토폴로지 — compact-ops) / 체인 시퀀싱(REMvisual) / 재귀 티어·통합(remember, mem0) / git 백업(DazzleML, ccgs) / PostCompact 활용.

**우리 차별점(US>THEY)**: 주제+UUID토큰 파일소유권=**동시 세션 무충돌**(조사 중 유일) / INDEX 자기줄만 쓰기=구조적 동시성 안전 / 2층 손실모델 + "비싼요약 미리·싼복사 마지막" 원칙 / 자동요약이 큐레이션 파일 **절대 안 덮어씀**(기계/사람 요약 분리).

## 6. 개선안 (출처 근거)
1. **[高] 복원 이중화** — [이슈 #15174](https://github.com/anthropics/claude-code/issues/15174): **SessionStart(compact) stdout이 자동압축 후 주입 안 되는 버그** 보고됨(우리 핵심 복원 경로!). UserPromptSubmit 훅으로 압축후 첫 프롬프트에 복원 리마인더 재주입(+PostCompact side-effect). compact-plus/ops가 이 방식.
2. **[高] 요약 작성 강제** — Stop(또는 PreCompact-block) 훅이 `.handoff/<토큰>.md` 실내용 채워질 때까지 재시도([thepushkarp/handoff](https://github.com/thepushkarp/handoff)).
3. **[高] 무LLM 결정론 폴백** — 아카이브 .jsonl서 최근 N 메시지 dedup + 파일경로 추출로 항상 뼈대 확보([who96](https://github.com/who96/claude-code-context-handoff)).
4. **[中] "원본 재읽기" 리마인더** — 압축 복원 메시지에 소스 재열람 지시([compact-plus](https://github.com/u-ichi/compact-plus)).
5. **[中] 스키마 강화** — "실패한 시도/막다른 길" + "서브에이전트 토폴로지" 섹션([compact-ops](https://github.com/kenimo49/compact-ops)).
6. **[中] 네이티브 MEMORY.md 관계 정리 + 티어링**으로 무한증가 방지([remember](https://github.com/Digital-Process-Tools/claude-remember), [mem0](https://github.com/mem0ai/mem0)).
7. **[低] git 백업 옵션**([DazzleML](https://github.com/DazzleML/Claude-Session-Backup), [ccgs](https://github.com/ingram-technologies/claude-git-sessions)).

## 캐비앗
- claude-mem 88k★ 이례적 높음(2 API 확인했으나 사람 재확인 권장).
- 자동압축 95%/CLAUDE_AUTOCOMPACT_PCT_OVERRIDE는 커뮤니티 소스.
- compact-ops/plus 등은 days/weeks 신생 — 메커니즘 변동 가능.
