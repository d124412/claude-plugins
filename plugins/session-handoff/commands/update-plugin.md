---
description: 이 플러그인을 마켓플레이스 최신 버전으로 업데이트한다 (/plugin update 를 쓸 수 없는 환경용)
---

이 플러그인(session-handoff)을 최신 버전으로 업데이트하라.

1. **스크립트 경로 확인** — `~/.claude/plugins/installed_plugins.json` 에서 `session-handoff@d124412-plugins` 의 `installPath` 를 읽고 거기에 `/scripts/handoff_hook.mjs` 를 붙인다.
2. **실행** — Bash 로:
   ```
   node "<스크립트경로>" update-plugin
   ```
3. 출력(이전→새 버전, 설치 경로, pull 결과)을 **한두 줄로** 사용자에게 알린다.
4. 버전이 올라갔으면 **"Claude Code 재시작이 필요하다"**고 반드시 알린다. 이미 최신이면 그렇다고만 알린다.

동작 요약:
- 마켓 클론(`~/.claude/plugins/marketplaces/d124412-plugins`)을 `git pull --ff-only`
- 새 버전을 `~/.claude/plugins/cache/d124412-plugins/session-handoff/<버전>/` 에 복사
- `installed_plugins.json` 의 버전·installPath·gitCommitSha 갱신 (`.bak` 백업 후)

> **왜 이 명령이 있나**: 정식 방법은 `/plugin update` 지만, Agent SDK/headless 등 일부 실행 컨텍스트에선 `/plugin` 관리 명령이 노출되지 않는다. 이 명령은 그때를 위한 대체 수단이다. `/plugin` 을 쓸 수 있는 환경이라면 그쪽이 정석이다.
