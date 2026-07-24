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

## 동작 원리 (훅)

| 시점 | 훅 이벤트 | 하는 일 |
|------|-----------|---------|
| 세션 시작 | `SessionStart` (startup/resume/clear/fork) | 규칙 리마인더 + **이번 세션 고유 토큰** 주입 → INDEX 읽고 자기 handoff 파일 생성 |
| **압축 직전** | `PreCompact` (manual/auto) | ① 원본 `.jsonl` **백업**(최신 5) ② 무LLM **폴백요약** `-fallback.md` ③ 복원 마커 남김 ④ *(실험)* 서브에이전트 **자동요약** `-autosummary.md` |
| **압축 직후** | `SessionStart` (compact) | 맥락 복원 리마인더 주입(+ "요약 말고 원본 재읽기" 지시) |
| **압축 후 첫 프롬프트** | `UserPromptSubmit` | 복원 마커 있으면 복원 리마인더 **재주입**(SessionStart 실패 대비) 후 마커 삭제 |
| 매 답변 끝 | `Stop` | 이 세션 handoff 파일이 **없을 때만** 만들라고 부드럽게 상기 |
| 세션 종료 | `SessionEnd` | `~/.claude/handoff-events.log`에 감사 기록 |

압축 후 컨텍스트에 텍스트를 주입할 수 있는 이벤트는 `SessionStart(compact)`가 기본이지만, 이 주입이 자동압축 때 누락되는 버그([#15174](https://github.com/anthropics/claude-code/issues/15174))가 있어 `UserPromptSubmit`로 **이중화**한다.

### 저장 층 (손실 관점)

| 층 | 누가 | 손실 | 정리 |
|----|------|------|------|
| 큐레이션 `.handoff/<토큰>.md` | Claude가 요약 | 요약이라 세부 생략(연속성 유지) | 세션당 1 |
| 원본 `.archive/*.jsonl` | 훅이 복사 | 거의 무손실 | 토큰별 최신 5개 |
| 무LLM 폴백 `-fallback.md` | 훅이 규칙 추출 | 뼈대만(항상 성공) | 덮어쓰기 1개 |
| *(실험)* 자동요약 `-autosummary.md` | 서브에이전트 | 대형 대화 시 부실 가능 | 덮어쓰기 1개 |

원칙: **비싼 이해 작업(요약)은 여유 있을 때 미리, 값싼 저장(원본 복사)은 마지막 순간에.**

## 파일 구조 (프로젝트마다 생성)

```
<프로젝트>/.handoff/                         # 전역 gitignore(**/.handoff/) 대상 — 커밋 안 됨
├── INDEX.md                                # 모든 세션 한 줄 요약(자기 줄만 갱신)
├── <주제>-<토큰>.md                        # 각 세션 전용 handoff (자기 것만 갱신)
└── .archive/
    ├── <토큰>-<시각>.jsonl                   # 압축 직전 원본(최신 5개, 초과분 자동삭제)
    ├── <토큰>-fallback.md                    # 무LLM 폴백요약(덮어쓰기)
    ├── <토큰>-autosummary.md                 # (실험) 자동요약(덮어쓰기)
    └── <토큰>.restore-pending                # 복원 마커(소비 즉시 삭제 · 자기청소)
```

- **세션식별자** = `<주제슬러그>-<세션토큰>` (예: `traffic-analysis-ba2968`). 토큰은 세션 UUID 앞 6자리라 동시 세션끼리 파일이 절대 안 겹친다.
- **아티팩트 정리**: 원본은 5개 유지, 요약/폴백은 덮어쓰기(각 1개), 마커는 자기청소. 무한히 쌓이는 건 없다. 유일한 append 파일은 `~/.claude/handoff-events.log`(이벤트당 1줄).

자세한 규칙은 [RULES.md](./RULES.md), 설계 배경/벤치마크는 [docs/PRIOR-ART.md](../../docs/PRIOR-ART.md) 참조.

## 실험 기능: 압축 직전 자동 요약 (v1.1.0+)

`PreCompact`의 `type: agent` 훅이 서브에이전트(haiku)로 최근 대화를 요약해 `-autosummary.md`를 남긴다. 큐레이션 파일은 **절대 안 건드림**. **끄는 법**: `hooks/hooks.json`의 `PreCompact` 안 `type: agent` 항목만 제거(무LLM 폴백·원본 백업은 유지). 주의: experimental, 압축마다 비용·지연.

## 명령어

| 명령 | 설명 |
|------|------|
| `/handoff [완료\|중단\|진행중]` | 현재 세션의 handoff 파일과 INDEX를 지금 최신화 |

## FAQ

- **Q. 훅이 안 도는데요?** → Claude Code를 재시작했는지, `node`가 PATH에 있는지 확인. `~/.claude/handoff-events.log`에 기록이 남는지로 점검.
- **Q. `Stop` 상기가 성가셔요.** → 세션 handoff 파일을 한 번 만들면(또는 `/handoff`) 조용해진다. 완전히 끄려면 `hooks.json`의 `Stop` 항목 제거.
- **Q. `.handoff/`가 git에 잡혀요.** → 전역 gitignore에 `**/.handoff/` 추가.

## 라이선스

[MIT](./LICENSE)
