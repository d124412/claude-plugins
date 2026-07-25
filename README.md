# claude-plugins

d124412 의 Claude Code 플러그인 마켓플레이스(저장소). 현재 **session-handoff** 플러그인을 배포한다.

> **이름 주의**: 저장소 경로는 `d124412/claude-plugins`(GitHub 주소)지만, **마켓플레이스 이름은 `d124412-plugins`** 다. 마켓 이름에 "claude"/"anthropic"을 쓰면 공식 마켓 사칭으로 Claude Code가 설치를 거부한다.

## 수록 플러그인

| 플러그인 | 설명 | 최신 버전 |
|----------|------|------|
| [session-handoff](./plugins/session-handoff/) | 여러 세션 동시성 + 컨텍스트 압축에 강한 세션 인수인계 시스템 | [CHANGELOG](./plugins/session-handoff/CHANGELOG.md) · [릴리스](https://github.com/d124412/claude-plugins/releases) |

> 버전 숫자를 여기 박아두지 않는다 — 손으로 갱신하면 반드시 낡는다(실제로 `1.2.0` 에 멈춰 있었다). 최신 버전은 위 CHANGELOG(맨 위 항목)/릴리스가 단일 출처이며, 세션 안에서는 `/version` 이 `plugin.json` 을 실시간으로 읽어 알려준다.

## 설치

```
/plugin marketplace add d124412/claude-plugins
/plugin install session-handoff@d124412-plugins
```

- `d124412/claude-plugins` = 이 저장소의 **GitHub 경로(주소)**. git URL·로컬 경로도 가능.
- `@d124412-plugins` = **마켓플레이스 이름**(`marketplace.json` 의 `name`).
- 설치 후 **Claude Code 재시작** → 새 세션부터 적용(user 스코프 = 전역).

## 업데이트

저장소에 커밋을 밀면 사용자는 아래로 최신본을 받는다.

```
/plugin marketplace update
/plugin update session-handoff
```

> `/plugin` 이 `isn't available in this environment` 이라고 뜨면(Agent SDK/headless 세션 등), 표준 `claude` 터미널 CLI에서 실행하면 된다.

## 저장소 구조

```
claude-plugins/
├── .claude-plugin/
│   └── marketplace.json          # name: d124412-plugins
├── docs/PRIOR-ART.md             # 벤치마크/설계 배경
└── plugins/
    └── session-handoff/
        ├── .claude-plugin/plugin.json
        ├── hooks/hooks.json
        ├── scripts/handoff_hook.mjs
        ├── commands/handoff.md
        ├── RULES.md  README.md  CHANGELOG.md  LICENSE
```

## 라이선스

[MIT](./plugins/session-handoff/LICENSE)
