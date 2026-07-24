# Changelog

이 플러그인의 모든 주요 변경사항을 기록한다.
형식은 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/), 버전은 [유의적 버전(SemVer)](https://semver.org/lang/ko/)을 따른다.

## [Unreleased]

### Fixed
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

[Unreleased]: https://github.com/d124412/claude-plugins/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/d124412/claude-plugins/releases/tag/v1.2.0
[1.1.0]: https://github.com/d124412/claude-plugins/releases/tag/v1.1.0
[1.0.0]: https://github.com/d124412/claude-plugins/releases/tag/v1.0.0
