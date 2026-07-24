# session-handoff

> 여러 세션이 동시에 돌아도 충돌하지 않고, 컨텍스트 압축(compact)이 나도 맥락을 잃지 않는 **세션 인수인계 시스템** — Claude Code 플러그인.

한 프로젝트에서 세션을 여러 개 띄우거나, 긴 세션 도중 컨텍스트가 압축되면 "이전에 뭘 하고 있었는지"가 흐려진다. 이 플러그인은 **훅**으로 그 순간들을 자동으로 붙잡아, 각 세션이 자기 진행상황을 `.handoff/` 파일에 남기고 필요할 때 되살리게 한다.

## 설치

```
/plugin marketplace add d124412/claude-plugins
/plugin install session-handoff@claude-plugins
```

설치 후 **Claude Code를 재시작**하면 모든 프로젝트의 새 세션부터 적용된다. (user 스코프 설치 시 전역 적용)

**요구사항**: 훅 실행에 `node`가 PATH에 있어야 한다(Claude Code 사용 환경엔 대개 존재).

## 동작 원리

| 시점 | 훅 이벤트 | 하는 일 |
|------|-----------|---------|
| 세션 시작 | `SessionStart` (startup/resume/clear/fork) | 규칙 리마인더 + **이번 세션 고유 토큰** 주입 → INDEX 읽고 자기 handoff 파일 생성 |
| **압축 직전** | `PreCompact` (manual/auto) | 대화 원본을 `.handoff/.archive/<토큰>-<시각>.jsonl`로 **자동 백업**(최신 5개 유지) |
| **압축 직후** | `SessionStart` (compact) | 맥락 복원 리마인더 주입 → INDEX·자기 파일 다시 읽기, 필요 시 아카이브 grep |
| 세션 종료 | `SessionEnd` | `~/.claude/handoff-events.log`에 감사 기록 |

압축 후 컨텍스트에 텍스트를 주입할 수 있는 이벤트는 `SessionStart(compact)`가 유일하므로, 복원은 이걸로 한다. 그 전에 `PreCompact`가 원본을 백업해 두므로, 요약본에서 세부가 사라져도 아카이브에서 되살릴 수 있다.

## 파일 구조 (프로젝트마다 생성)

```
<프로젝트>/.handoff/
├── INDEX.md                      # 모든 세션 한 줄 요약(자기 줄만 갱신)
├── <주제>-<토큰>.md              # 각 세션 전용 handoff (자기 것만 갱신)
└── .archive/
    └── <토큰>-<시각>.jsonl        # 압축 직전 대화 원본 백업(토큰별 최신 5개)
```

- **세션식별자** = `<주제슬러그>-<세션토큰>` (예: `traffic-analysis-ba2968`). 토큰은 세션 UUID 앞 6자리라 동시 세션끼리 파일이 절대 안 겹친다.
- `.handoff/`는 로컬/머신 전용 스크래치 → **git에 커밋하지 말 것**(전역 gitignore에 `**/.handoff/` 권장).

자세한 규칙은 [RULES.md](./RULES.md) 참조.

## 명령어

| 명령 | 설명 |
|------|------|
| `/handoff [완료\|중단\|진행중]` | 현재 세션의 handoff 파일과 INDEX를 지금 최신화 |

## 여러 세션이 왜 안 부딪히나

한 세션은 오직 **자기 파일 하나 + INDEX의 자기 줄 하나**만 쓴다. 세션마다 파일이 다르니 동일 파일 동시 쓰기가 없다. 시작할 때 `INDEX.md`만 먼저 읽어 겹치는 진행중 세션을 감지한다.

## FAQ

- **Q. 훅이 안 도는데요?** → Claude Code를 재시작했는지, `node`가 PATH에 있는지 확인. `~/.claude/handoff-events.log`에 압축/종료 기록이 남는지로 점검.
- **Q. `.handoff/`가 git에 잡혀요.** → 전역 gitignore에 `**/.handoff/` 추가.
- **Q. 아카이브가 계속 쌓이나요?** → 토큰(세션)별 최신 5개만 유지하고 자동 정리된다.

## 라이선스

[MIT](./LICENSE)
