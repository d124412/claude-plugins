---
description: 지금 대화 원본(.jsonl)을 .handoff/.archive/ 로 즉시 스냅샷한다 (압축 없이)
---

지금 이 세션의 **대화 원본을 스냅샷**하라. 압축(compact)은 일으키지 말고 복사만 한다.

1. **세션 UUID 확인** — 환경의 스크래치패드 경로 등에서 이번 세션 UUID를 찾는다(예: `...\<uuid>\scratchpad`).
2. **스크립트 경로 확인** — `~/.claude/plugins/installed_plugins.json` 에서 `session-handoff@d124412-plugins` 의 `installPath` 를 읽고 거기에 `/scripts/handoff_hook.mjs` 를 붙인다.
3. **실행** — Bash 로:
   ```
   node "<스크립트경로>" snapshot --session <uuid> --cwd "<현재 프로젝트 경로>"
   ```
4. 출력(생성된 파일명·크기·위치)을 **한두 줄로** 사용자에게 알린다. 실패하면 이유를 그대로 알린다.

동작 요약:
- 대화 원본을 `.handoff/.archive/<토큰>-snap-<시각>.jsonl` 로 복사
- 무LLM 폴백 요약 `<토큰>-fallback.md` 도 함께 갱신
- 수동 스냅샷은 **최신 3개만 유지**(자동 압축백업 `<토큰>-<시각>.jsonl` 과 분리되어 서로 밀어내지 않음)

주의: 이 명령은 **원본 복사 + 기계 추출 요약**만 한다. 사람이 읽는 큐레이션 핸드오프(`.handoff/<주제>-<토큰>.md`)는 건드리지 않는다 — 그건 `/handoff` 명령이다.
