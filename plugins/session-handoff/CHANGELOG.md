# Changelog

이 플러그인의 모든 주요 변경사항을 기록한다.
형식은 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/), 버전은 [유의적 버전(SemVer)](https://semver.org/lang/ko/)을 따른다.

## [Unreleased]

## [1.4.0] - 2026-07-25

### Added
- **`/restore` 명령 + `distill` 모드** — 대화 원본(.jsonl)에서 메타데이터(`uuid`/`usage`/`requestId`/`cache_*`/`model`/`stop_reason` 등)를 걷어내고 **주고받은 전체 대화**를 읽을 수 있는 마크다운 `.handoff/.archive/<토큰>-full.md` 로 정제한다. 그 정제본을 Read 하면 **요약본이 아닌 전문**이 컨텍스트로 복귀한다.
  - 실측: **5.78 MB → 0.66 MB (▼89%)** — 메타데이터가 대부분이라 통째로 다시 읽어도 컨텍스트에 들어간다.
  - 보존: 사용자·Claude 발언 **전문**, 도구 호출(인자), 도구 결과(**전문**, 접기 처리), 이미지 자리표시.
  - 사고과정(thinking) 블록은 기본 제외, `/restore thinking` 으로 포함 가능.
  - 안전: 원본 `.jsonl` 직접 Read 금지(수 MB), 정제본만 읽는다. 1.5MB 초과 시 사용자에게 확인 후 진행.
- **원본 자동 선택** — 라이브 transcript 와 아카이브 사본 중 **줄 수가 많은(더 완전한) 쪽**을 자동으로 고른다.

### Notes (공식 문서 검증 반영)
- **실측**: 같은 세션에서 압축직전 아카이브 1320줄 → 압축 후 라이브 1571줄(첫 메시지 타임스탬프 동일) → 라이브가 상위집합으로 관측. 커뮤니티 문서도 transcript 는 append-only 이며 압축은 `summary` 레코드를 덧붙인다고 설명한다.
- **그러나 공식 문서는 이를 보장하지 않는다.** [sessions 문서](https://code.claude.com/docs/en/sessions)는 *"엔트리 포맷은 Claude Code 내부용이며 버전마다 바뀌므로, 이 파일을 직접 파싱하는 스크립트는 어떤 릴리스에서든 깨질 수 있다"* 고 명시한다.
- **압축 중 transcript 손상·유실 버그가 보고돼 있다**: [#62965](https://github.com/anthropics/claude-code/issues/62965)(압축이 블록 쌍을 분리·변조한 상태로 디스크에 기록), [#40352](https://github.com/anthropics/claude-code/issues/40352)(압축 중 rate limit 발생 시 전체 transcript 파손). → **압축 *전에* 떠두는 PreCompact 아카이브 사본이 바로 이 실패 모드의 안전망**이다.
- 방어책: ① 원본은 **더 완전한 쪽 자동 선택**, ② 파서는 **줄 단위 try/catch**로 깨진 줄을 건너뜀, ③ **압축 전 사본을 계속 유지**.
- 세션 보관은 기본 **30일**(`cleanupPeriodDays`). 그 이후엔 `.handoff/.archive/` 사본만 남는다.
- 이제 명령이 3개다: `/handoff`(요약 저장) · `/snapshot`(원본 사본) · `/restore`(전문 복원).

## [1.3.0] - 2026-07-25

### Added
- **`/snapshot` 명령**: 압축을 기다리지 않고 **지금 대화 원본(.jsonl)을 `.handoff/.archive/<토큰>-snap-<시각>.jsonl` 로 즉시 복사**(압축은 일으키지 않음). 무LLM 폴백 요약도 함께 갱신. 수동 스냅샷은 **최신 3개**만 유지하며, 자동 압축백업(`<토큰>-<시각>.jsonl`)과 파일명이 분리되어 서로 밀어내지 않는다.

### Removed
- **실험적 `type: agent` 자동요약 훅 제거.** 실제 압축에서 `Agent stop hooks are not yet supported outside REPL` 로 **실패**했고, 실패하면서 프롬프트 전문을 화면에 출력해 로그를 오염시켰다. 같은 역할은 v1.2.0의 **무LLM 결정론 폴백**(`-fallback.md`)이 공짜·항상성공으로 대신한다(실측: 5.4MB 원본 + 7.4KB 폴백 정상 생성).

### Fixed
- `pruneArchive` 가 수동 스냅샷(`-snap-`)을 자동백업 정리 대상에서 제외하도록 수정(스냅샷이 자동백업을 밀어내지 않음).
- **마켓플레이스 이름** `claude-plugins` → `d124412-plugins`: "claude" 포함 이름이 *"Marketplace name impersonates an official Anthropic/Claude marketplace"* 로 거부되는 문제 회피. 설치 명령이 `/plugin install session-handoff@d124412-plugins` 로 변경됨(저장소 경로 `d124412/claude-plugins`는 그대로).
- 설치 문서: `/plugin`이 노출되지 않는 실행 컨텍스트(Agent SDK/headless 등)에 대한 안내 + 표준 터미널/로컬경로/수동 설치 절차 추가.

## [1.2.0] - 2026-07-25

벤치마킹(→ `docs/PRIOR-ART.md`)에서 나온 신뢰성 개선 4종.

### Added
- **복원 이중화 (`UserPromptSubmit` 훅)**: `PreCompact`가 복원 마커(`.handoff/.archive/<토큰>.restore-pending`)를 남기고, 압축 후 첫 사용자 프롬프트에서 복원 리마인더를 재주입한 뒤 마커를 삭제. `SessionStart(compact)` stdout 미주입 버그([anthropics/claude-code#15174](https://github.com/anthropics/claude-code/issues/15174)) 대비 안전줄.
- **무LLM 결정론 폴백 (`PreCompact`)**: transcript를 기계적으로 파싱해 최근 사용자 요청·편집 파일·활동 발췌를 `.handoff/.archive/<토큰>-fallback.md`로 저장(항상 성공, 덮어쓰기). 큐레이션·자동요약이 비어도 최소 복구 뼈대 확보.
- **요약 작성 부드러운 강제 (`Stop` 훅)**: 이 세션의 handoff 파일이 아직 없을 때만 "만들어 두라"는 한 줄을 상기(종료 차단 없음). 파일이 생기면 조용.
- **원본 재읽기 리마인더**: 압축 복원 메시지에 "요약 맹신 말고 실제 소스 파일을 다시 열어 확인" 지시 추가(compact-plus/ops 검증 문구).

### Changed
- `handoff_hook.mjs`에 `prompt`/`stop` 모드 추가, `precompact`가 폴백 생성·복원 마커까지 수행.

### Notes
- 아티팩트 정리: 복원 마커는 소비 즉시 삭제(자기청소), 폴백·자동요약 md는 매 압축 덮어쓰기(각 1개), 원본 .jsonl은 최신 5개 유지. 전부 `.handoff/`(gitignore) 내부.
- 비용: `UserPromptSubmit`/`Stop`은 자주 발동하나 할 일 없으면 즉시 종료(파일 존재 체크만).

## [1.1.0] - 2026-07-25

### Added
- **압축 직전 자동 요약(실험적)**: `PreCompact`에 **agent 훅** 추가. 서브에이전트(haiku)가 압축 직전 대화 원본의 최근 부분을 읽어 `.handoff/.archive/<토큰>-autosummary.md`로 요약 저장.
  - 사람이 쓴 큐레이션 `.handoff/<토큰>.md`는 **절대 건드리지 않음**(별도 파일) → 덮어쓰기 위험 없음.
  - 실패해도 기존 원본 백업(command 훅)·큐레이션 흐름엔 영향 없음(독립).
- 압축 복원 리마인더에 `-autosummary.md` 안내 추가.

### Notes
- agent 훅은 **experimental**. 대형 대화에선 요약이 부실할 수 있고, 압축마다 서브에이전트 비용·지연(수십 초)이 든다.
- 자동 요약을 끄려면 `hooks/hooks.json`의 `PreCompact` 내 `type: agent` 항목만 제거하면 된다(원본 백업 command 훅은 유지).
- 모델(`claude-haiku-4-5-20251001`)은 `hooks.json`에서 변경 가능.

## [1.0.0] - 2026-07-25

첫 릴리스. 세션 인수인계 시스템 전체를 플러그인으로 패키징.

### Added
- **세션별 handoff 파일 + 통합 INDEX**: 각 세션은 `.handoff/<세션식별자>.md` 하나만 소유하고, `.handoff/INDEX.md`에 한 줄 요약만 기록. 파일 단위 소유권으로 **동시 세션 충돌을 원천 차단**.
- **세션식별자 규칙**: `<주제슬러그>-<세션토큰>` 형식. 세션토큰은 세션 UUID 앞 6자리로, 훅이 세션 시작·압축 시 주입해 동시 세션 슬러그 충돌(경쟁 조건)을 방지.
- **`SessionStart` 훅**:
  - `startup|resume|clear|fork` → 세션 시작 리마인더 + 고유 토큰 주입.
  - `compact` → **압축 직후** 맥락 복원 리마인더 주입.
- **`PreCompact` 훅**: 압축 직전(수동/자동 모두) 대화 원본(transcript)을 `.handoff/.archive/<토큰>-<시각>.jsonl`로 **자동 백업**. 토큰별 최신 5개만 유지.
- **`SessionEnd` 훅**: 세션 종료 이벤트를 `~/.claude/handoff-events.log`에 감사 기록.
- **`/handoff` 명령**: 현재 세션의 handoff 파일과 INDEX를 수동으로 즉시 최신화.
- **크로스플랫폼 훅**: Node.js(`scripts/handoff_hook.mjs`) + `${CLAUDE_PLUGIN_ROOT}` 호출.
- **문서**: `RULES.md`, `README.md`, `LICENSE`(MIT).

### Notes
- 훅은 Claude Code **재시작 후** 새 세션부터 적용된다.
- 런타임 의존: 훅 실행에 `node`가 PATH에 있어야 한다.

[Unreleased]: https://github.com/d124412/claude-plugins/compare/v1.4.0...HEAD
[1.4.0]: https://github.com/d124412/claude-plugins/releases/tag/v1.4.0
[1.3.0]: https://github.com/d124412/claude-plugins/releases/tag/v1.3.0
[1.2.0]: https://github.com/d124412/claude-plugins/releases/tag/v1.2.0
[1.1.0]: https://github.com/d124412/claude-plugins/releases/tag/v1.1.0
[1.0.0]: https://github.com/d124412/claude-plugins/releases/tag/v1.0.0
