# Changelog

이 플러그인의 모든 주요 변경사항을 기록한다.
형식은 [Keep a Changelog](https://keepachangelog.com/ko/1.1.0/), 버전은 [유의적 버전(SemVer)](https://semver.org/lang/ko/)을 따른다.

## [Unreleased]

## [1.1.0] - 2026-07-25

### Added
- **압축 직전 자동 요약(실험적)**: `PreCompact`에 **agent 훅**을 추가. 압축 직전 서브에이전트(모델: haiku)가 대화 원본(transcript)의 최근 부분을 읽어 `.handoff/.archive/<토큰>-autosummary.md`로 요약 저장.
  - 사람이 쓴 큐레이션 `.handoff/<토큰>.md`는 **절대 건드리지 않음**(항상 별도 파일에만 기록) → 덮어쓰기 위험 없음.
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
  - `compact` → **압축 직후** 맥락 복원 리마인더 주입(압축 후 컨텍스트에 주입 가능한 유일한 지점).
- **`PreCompact` 훅**: 압축 직전(수동/자동 모두) 대화 원본(transcript)을 `.handoff/.archive/<토큰>-<시각>.jsonl`로 **자동 백업**. 토큰별 최신 5개만 유지(디스크 무한 증가 방지).
- **`SessionEnd` 훅**: 세션 종료 이벤트를 `~/.claude/handoff-events.log`에 감사 기록.
- **`/handoff` 명령**: 현재 세션의 handoff 파일과 INDEX를 수동으로 즉시 최신화. 인자로 상태(`완료`/`중단`/`진행중`) 지정 가능.
- **크로스플랫폼 훅**: 훅 로직을 Node.js(`scripts/handoff_hook.mjs`)로 구현하고 `${CLAUDE_PLUGIN_ROOT}`로 호출 → Windows/macOS/Linux에서 경로·사용자명 무관하게 동작.
- **문서**: `RULES.md`(규칙 전문), `README.md`(사용법·동작 원리), `LICENSE`(MIT).

### Notes
- 훅은 Claude Code **재시작 후** 새 세션부터 적용된다.
- `compact` 매처의 압축-후 주입은 수동 압축에서 문서상 보장되며, 자동 압축에서도 실전 동작한다. 어느 경우든 `PreCompact` 원본 백업이 안전망이므로 맥락은 보존된다.
- 런타임 의존: 훅 실행에 `node`가 PATH에 있어야 한다(Claude Code 사용 환경엔 대개 존재).

[Unreleased]: https://github.com/d124412/claude-plugins/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/d124412/claude-plugins/releases/tag/v1.1.0
[1.0.0]: https://github.com/d124412/claude-plugins/releases/tag/v1.0.0
