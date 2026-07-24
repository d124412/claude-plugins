# Changelog

이 플러그인의 모든 주요 변경사항을 기록한다.
형식은 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/), 버전은 [유의적 버전(SemVer)](https://semver.org/lang/ko/)을 따른다.

## [Unreleased]

## [1.6.0] - 2026-07-25

### Added
- **`/version` 명령 + `version` 모드** — **로드됨 / 설치됨 / 마켓 최신** 세 버전을 비교해 *"재시작이 필요한지, 업데이트가 필요한지"* 를 판정한다.
  - 배경: 업데이트해도 **명령문(.md)은 세션 시작 시 1회만 로드**되는 반면 **스크립트는 실행 시점에 `installPath` 로 조회**된다. 그래서 *"명령문은 구버전, 스크립트는 최신"* 인 혼합 상태가 생기는데, 이걸 눈으로 확인할 방법이 없었다.
- **세션 시작 시 버전 주입** — `SessionStart`(startup/resume/clear/fork/compact) 리마인더에 `session-handoff vX.Y.Z 로드됨` 한 줄을 추가한다. **이 값이 곧 "이 세션이 로드한 버전"** 이라 위 혼합 상태를 정확히 진단할 수 있다.
  - 버전은 스크립트가 **자기 옆의 `plugin.json` 을 직접 읽어** 얻는다(`import.meta.url` 기준). 버전 문자열을 여기저기 수동으로 박아둘 필요가 없어 갱신 누락이 원천적으로 없다.
  - 마켓 최신 버전은 `git fetch` 후 `origin/main` 의 `plugin.json` 에서 읽는다(로컬 클론 상태에 속지 않음).

### Notes
- 판정: 셋 다 같으면 최신 / 로드됨≠설치됨 → **재시작 필요** / 설치됨≠마켓최신 → **`/update-plugin`**.
- 이제 명령이 5개다: `/handoff` · `/snapshot` · `/restore` · `/update-plugin` · `/version`.

## [1.5.3] - 2026-07-25

### Changed
- **`/restore` 기본값: 도구 결과 `500자 절단` → `덤프 제외`.** "왜 하필 500자인가"에 답할 수 없는 **매직넘버를 제거**하고 모드를 둘로 단순화했다 — **기본은 덤프 빼고, `full` 은 전부.**
  - 덤프를 빼도 **도구 이름·인자·결과 한 줄 미리보기는 보존**되어 "무엇을 했는지"는 남는다. 덤프 자체는 파일 내용·명령 출력이라 필요하면 디스크에서 다시 읽으면 된다.
  - 실측: 기본 **0.37 MB / 4,570줄 / ~118k 토큰**(1M의 12%), `full` 1.16 MB / 19,416줄 / ~362k(36%). 줄 수가 1/4이라 Read 호출 횟수도 크게 준다.
  - 덤프 제외 모드에서는 결과를 `<details>` 코드블록 대신 **한 줄 미리보기**로 렌더링한다(빈 코드블록 노이즈 제거).
- 정제본 헤더에 **도구 결과 처리 방식**을 명시한다(덤프 제외 / 전문 보존 / N자 절단).

### Notes
- `--tool-result <숫자>` 로 중간값 지정은 여전히 가능하지만 **권장하지 않는다**(매직넘버를 다시 만드는 셈).
- 사용자·Claude 발언은 **어느 모드에서도 100% 전문** 보존된다.

## [1.5.2] - 2026-07-25

### Fixed
- **IDE/시스템 주입 블록이 "사용자 발언"으로 잡히던 문제.** `<ide_opened_file>`, `<ide_selection>`, `<system-reminder>` 는 사용자가 실제로 한 말이 아닌데 정제본에 사용자 메시지로 들어가, 복원 시 "사용자가 이렇게 말했다"는 오해를 유발했다.
  - 이제 **사용자 텍스트에서만** 해당 블록을 제거하고, 그것만 있던 메시지는 **통째로 버린다**(실측 10건 제거 — 정제본 첫 메시지가 노이즈에서 실제 발언으로 교정됨).
  - 어시스턴트 발언이나 도구 결과 안에 같은 문자열이 있으면 **정당한 내용이므로 건드리지 않는다.**
  - 정제본 헤더에 제거 건수를 표기한다.

### Notes
- 사고과정(`thinking`) 포함 옵션은 그대로 둔다(`/restore thinking`). 실측상 현재 transcript 에는 thinking 블록이 **0개**로, 켜도 실익이 없다. 저장되는 버전이 오면 그때 유효해진다.
- 절단값 관련 재확인(한글/ASCII 구성 기반 추정): `full` 1.14 MB ≈ **355k 토큰**(1M 컨텍스트의 35%), 기본(500자) 0.44 MB ≈ **137k**(14%). **나눠 읽어도 총 컨텍스트 소모량은 줄지 않으므로**, 절단은 "호출당 한도"가 아니라 **"전체 예산"** 을 위한 것이다.

## [1.5.1] - 2026-07-25

`/restore` 가 실사용에서 못 읽히는 문제를 고친 패치. 새 기능은 없다 — 기존 동작(도구결과 전문)을 `full` 인자 뒤로 옮기고, 기본값을 읽을 수 있는 크기로 교정했다.

### Fixed
- **`distill` 기본 절단값 `-1`(전문) → `500자`.** 전문 정제본은 **1.12 MB / 18,714줄 / 약 368k 토큰**이라 사실상 읽을 수 없었다(원본 콘텐츠의 **약 2/3가 도구 결과 덤프**). 새 기본값은 **0.42 MB / 7,110줄 / 약 139k 토큰**으로, 200k 컨텍스트 모델에서도 안전하다. **사용자·Claude 발언은 어떤 설정에서도 100% 전문 보존**된다.
- **`/restore` 가 도중에 스스로 방식을 바꾸던 문제.** 기존 명령문의 "1.5MB 초과면 물어본다" 조항이 모델의 임의 판단(중간에 재정제·일부만 읽고 grep으로 대체)을 유발했다. 이제:
  - 읽기 전에 **"N줄이라 Read 도구의 호출당 25k 토큰 제한 때문에 M회로 나눠 전부 읽는다"**고 **이유와 함께 먼저 알린다.**
  - **중간 재정제·부분 읽기·grep 대체·조기 중단을 금지**한다.
  - 예상보다 훨씬 클 때는 임의로 줄이지 말고 **사용자에게 지시를 받는다.**

### Added
- **`/restore full`** — 기존 동작(도구 결과 전문) 유지용 인자. 약 368k 토큰이라 **1M 컨텍스트에서만 현실적**이다.
  - 특정 값이 필요하면 `--tool-result <숫자>` 로 직접 지정 가능(기존부터 있던 옵션).

### Notes
- 절단 수준을 500 아래로 낮출 실익은 없다(0자로 생략해도 0.34 MB — 발언 본문과 도구 호출 인자가 하한).
- 적정선은 **모델의 컨텍스트 크기에 따라 다르며 스크립트는 모델을 알 수 없다.** 그래서 기본값은 어디서나 안전한 쪽에 두고, 큰 컨텍스트일 때만 `full` 을 쓰도록 문서화했다.

## [1.5.0] - 2026-07-25

### Added
- **`/update-plugin` 명령 + `update-plugin` 모드** — 이 플러그인을 마켓플레이스 최신 버전으로 업데이트한다.
  - 마켓 클론을 `git pull --ff-only` → 새 버전을 `~/.claude/plugins/cache/<마켓>/<플러그인>/<버전>/` 에 복사 → `installed_plugins.json` 의 `version`/`installPath`/`gitCommitSha` 갱신(`.bak` 백업 후).
  - 이미 최신이면 아무것도 바꾸지 않고 그렇게만 알린다. 적용엔 **Claude Code 재시작** 필요.
- **왜 필요한가**: 정식 방법은 `/plugin update` 지만 Agent SDK/headless 등 일부 실행 컨텍스트에선 `/plugin` 관리 명령이 **노출되지 않는다**. 이 명령은 그 환경을 위한 대체 수단이다(`/plugin` 을 쓸 수 있으면 그쪽이 정석).

### Notes
- 명령 이름은 공식 마켓플레이스의 작명 관례(verb-first: `create-plugin`, `review-pr`, `revise-claude-md`)를 따라 `update-plugin` 으로 정했다. 공식/bkit 마켓 어디에도 self-update 계열 명령이 없어(공식 `/plugin update` 가 있으므로) 따를 선례가 없었다.
- 이제 명령이 4개다: `/handoff`(요약 저장) · `/snapshot`(원본 사본) · `/restore`(전문 복원) · `/update-plugin`(플러그인 갱신).

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

[Unreleased]: https://github.com/d124412/claude-plugins/compare/v1.6.0...HEAD
[1.6.0]: https://github.com/d124412/claude-plugins/releases/tag/v1.6.0
[1.5.3]: https://github.com/d124412/claude-plugins/releases/tag/v1.5.3
[1.5.2]: https://github.com/d124412/claude-plugins/releases/tag/v1.5.2
[1.5.1]: https://github.com/d124412/claude-plugins/releases/tag/v1.5.1
[1.5.0]: https://github.com/d124412/claude-plugins/releases/tag/v1.5.0
[1.4.0]: https://github.com/d124412/claude-plugins/releases/tag/v1.4.0
[1.3.0]: https://github.com/d124412/claude-plugins/releases/tag/v1.3.0
[1.2.0]: https://github.com/d124412/claude-plugins/releases/tag/v1.2.0
[1.1.0]: https://github.com/d124412/claude-plugins/releases/tag/v1.1.0
[1.0.0]: https://github.com/d124412/claude-plugins/releases/tag/v1.0.0
