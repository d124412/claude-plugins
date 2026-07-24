# claude-plugins

Claude Code 플러그인 마켓플레이스. 현재 **session-handoff** 플러그인을 배포한다.

## 수록 플러그인

| 플러그인 | 설명 | 버전 |
|----------|------|------|
| [session-handoff](./plugins/session-handoff/) | 여러 세션 동시성 + 컨텍스트 압축에 강한 세션 인수인계 시스템 | 1.0.0 |

## 설치

```
/plugin marketplace add d124412/claude-plugins
/plugin install session-handoff@claude-plugins
```

- `d124412/claude-plugins` 는 이 저장소의 GitHub 경로(예: `dyjung/session-claude-plugins`). git URL 이나 로컬 경로도 가능.
- 설치 후 **Claude Code 재시작** → 새 세션부터 적용.

## 업데이트

이 저장소에 커밋을 밀면 사용자는 아래로 최신본을 받는다.

```
/plugin marketplace update            # 마켓플레이스 새로고침
/plugin update session-handoff        # 플러그인 업데이트
```

> 기본적으로 플러그인은 백그라운드에서 자동 업데이트된다. 버전 고정은 `plugin.json`/`marketplace.json`의 `version`으로 관리한다(버전을 올릴 때만 사용자에게 업데이트로 잡힘).

## 저장소 구조

```
claude-plugins/
├── .claude-plugin/
│   └── marketplace.json          # 마켓플레이스 매니페스트
└── plugins/
    └── session-handoff/
        ├── .claude-plugin/plugin.json
        ├── hooks/hooks.json      # SessionStart/PreCompact/SessionEnd
        ├── scripts/handoff_hook.mjs
        ├── commands/handoff.md   # /handoff
        ├── RULES.md  README.md  CHANGELOG.md  LICENSE
```

## 라이선스

[MIT](./plugins/session-handoff/LICENSE)
