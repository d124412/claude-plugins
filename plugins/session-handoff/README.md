# session-handoff

> 여러 세션이 동시에 돌아도 충돌하지 않고, 컨텍스트 압축(compact)이 나도 맥락을 잃지 않는 **세션 인수인계 시스템** — Claude Code 플러그인.

한 프로젝트에서 세션을 여러 개 띄우거나, 긴 세션 도중 컨텍스트가 압축되면 "이전에 뭘 하고 있었는지"가 흐려진다. 이 플러그인은 **훅**으로 그 순간들을 자동으로 붙잡아, 각 세션이 자기 진행상황을 `.handoff/` 파일에 남기고 필요할 때 되살리게 한다.

## 설치

**표준 Claude Code (터미널 CLI):**
```
/plugin marketplace add d124412/claude-plugins
/plugin install session-handoff@d124412-plugins
```
- `d124412/claude-plugins` = 저장소 GitHub 주소, `@d124412-plugins` = 마켓플레이스 이름.
- 설치 후 **Claude Code를 재시작**하면 모든 프로젝트의 새 세션부터 적용된다. (user 스코프 = 전역)

> ### ⚠️ `/plugin isn't available in this environment` 이 뜨면?
> `/plugin`은 **대화형 관리 명령**이라, Agent SDK/headless 등 일부 실행 컨텍스트에서는 노출되지 않을 수 있다(이 경우에도 이미 설치된 플러그인은 정상 로드됨). 표준 대화형 Claude Code(터미널 등)에서는 동작한다.
> - **가장 쉬움**: 별도 표준 `claude` 터미널 CLI를 열어 위 두 명령 실행 → 이후 그 환경에서도 재시작 후 로드.
> - **로컬 경로로 추가**도 가능: `/plugin marketplace add <이 저장소를 clone 한 로컬 경로>`

### 수동 설치 (고급 — `/plugin` 을 전혀 못 쓸 때)
Claude Code는 아래 파일들로 플러그인을 관리한다. 기존 플러그인(예: bkit) 항목을 참고해 같은 형식으로 추가한 뒤 재시작한다(수정 전 백업 권장):
1. `~/.claude/plugins/known_marketplaces.json` — 마켓 등록(`source.github.repo` = `d124412/claude-plugins`, `installLocation` = clone 위치)
2. `~/.claude/plugins/marketplaces/<owner-repo>/` — 이 저장소 clone (예: `d124412-claude-plugins/`)
3. `~/.claude/plugins/cache/d124412-plugins/session-handoff/<버전>/` — `plugins/session-handoff/` 내용 복사(`${CLAUDE_PLUGIN_ROOT}`가 여기를 가리킴)
4. `~/.claude/plugins/installed_plugins.json` — `"session-handoff@d124412-plugins"` 항목 추가
5. `~/.claude/settings.json` → `enabledPlugins`에 `"session-handoff@d124412-plugins": true`

**요구사항**: 훅 실행에 `node`가 PATH에 있어야 한다.

## 명령어

| 명령 | 방향 | 설명 |
|------|------|------|
| `/handoff [완료\|중단\|진행중]` | 저장(요약) | 내 세션 폴더의 `handoff.md` 와 INDEX를 지금 최신화 |
| `/snapshot` | 저장(원본) | 압축 없이 지금 대화 원본(.jsonl)을 세션 폴더의 `archive/`로 즉시 복사 |
| `/restore [normal|lite|full] [thinking]` | **복원(전문)** | 원본을 정제해 **주고받은 전체 대화**를 컨텍스트로 되살림 |
| `/update-plugin` | 관리 | 이 플러그인을 마켓 최신 버전으로 업데이트 (`/plugin update` 를 못 쓰는 환경용) |
| `/version` | 관리 | **로드됨 / 설치됨 / 마켓최신** 버전을 비교해 재시작·업데이트 필요 여부 판정 |

### `/restore` — 요약이 아니라 "전문"을 되살린다
원본 `.jsonl` 은 `uuid`/`usage`/`requestId`/`cache_*` 같은 **메타데이터가 대부분**이다. 실측하면 6.93 MB 원본 중 실제 콘텐츠는 1.18 MB뿐이고, 그중 **도구 결과 덤프가 67%**, **주고받은 발언은 0.19 MB(2.7%)** 에 불과하다.

모드는 **셋**이다. 임의의 절단 길이 같은 매직넘버는 두지 않는다.

| 모드 | 도구 블록 | 도구 결과 | 도구 호출 인자 | 크기 | 추정 토큰 |
|---|---|---|---|---|---|
| `/restore lite` | **제외**(색인만) | — | — | 0.15 MB | **~53k** |
| **`/restore`** (= `normal`) | 포함 | **덤프 제외**(한 줄 미리보기) | **대상만** | 0.23 MB | ~95k |
| `/restore full` | 포함 | **전문**(무손실) | **전문** | 0.62 MB | ~290k |

- **어떤 모드든 사용자·Claude 발언은 100% 전문 보존.** 빠지는 건 덤프뿐이고, 그건 파일 내용·명령 출력이라 디스크에서 다시 읽으면 된다.
- **"덤프"는 결과에만 있는 게 아니다.** `Edit` 의 `old/new_string`, `Write` 의 `content`, `Bash` 의 heredoc 본문, `Agent` 의 `prompt` 도 같은 성격이다. `normal` 은 이것들도 빼고 **대상**만 남긴다:
  - `Read`/`Write`/`Edit` → `file_path` (+ 변경·내용 규모) · `Bash` → 명령 전문(heredoc 본문만 생략)
  - `Grep`/`Glob` → `pattern` · `Agent` → `description` · `WebFetch` → `url`
- **발언 번호 `[N]` 은 세 모드에서 동일**하다(도구 블록은 번호를 소비하지 않는다).
- 굳이 중간값이 필요하면 `--tool-result <숫자>` 로 지정할 수 있다(권장하지 않음).

#### 드릴다운 — 가볍게 읽고, 필요할 때만 파고든다
**어느 모드로 돌리든 무손실본 `restore/restore-full.md` 가 항상 함께 생성된다.** 그리고 `lite`/`normal` 머리말에는 **드릴다운 색인**이 붙는다 — 건드린 파일마다 무손실본의 **줄번호**가 적힌다.

```
### 드릴다운 색인 — 건드린 파일 41개
  - `auth_step_01.php` — 874
  - `INDEX.md` — 8338, 8349, 8370
```

→ "그 파일 내역을 자세히" 하면 `Read(restore-full.md, offset=854, limit=80)` 한 번이면 된다. **grep 도 필요 없다.** 같은 실행에서 함께 만들어지므로 줄번호가 어긋나지 않는다.

가벼운 모드로 시작해도 손해가 없다 — `lite` 로 아끼는 ~42k 토큰이면 **한 지점당 약 2.5k 씩 16번쯤 파고들 수 있다.**

> 정제본은 세션 폴더의 `restore/restore-{lite,normal,full}.md` 로 **매번 덮어쓴다.** 원본만 있으면 재생성되는 파생물이라 백업하지 않는다(세션당 최대 3개, 안 쌓인다).
- 사고과정 블록은 기본 제외 → `/restore thinking` 으로 포함
- **원본 `.jsonl` 은 직접 읽지도, grep 하지도 않는다** — 메시지 1개가 1줄이라(평균 3천 자, 최대 28만 자) 전후 읽기가 성립하지 않는다
- 라이브 원본과 아카이브 중 **더 완전한 쪽을 자동 선택**
- **읽기 방식이 결정적**: Read 도구가 호출당 25k 토큰 제한이라 여러 번 나눠 읽는다. 명령은 **왜 나눠 읽는지 먼저 밝히고 끝까지 전부** 읽으며, 도중에 임의로 재정제하거나 grep으로 대체하지 않는다.

> #### ⚠️ 원본 포맷에 대한 주의 (공식 문서 확인)
> [공식 sessions 문서](https://code.claude.com/docs/en/sessions)는 transcript 엔트리 포맷이 **"Claude Code 내부용이며 버전마다 바뀌어, 직접 파싱하는 스크립트는 어떤 릴리스에서든 깨질 수 있다"**고 명시한다. 또 압축 중 transcript가 **손상**([#62965](https://github.com/anthropics/claude-code/issues/62965))되거나 **통째로 유실**([#40352](https://github.com/anthropics/claude-code/issues/40352))되는 버그가 보고돼 있다.
>
> 그래서 이 플러그인은 이렇게 방어한다:
> - **압축 *전에* 원본 사본을 떠둔다**(PreCompact 아카이브) — 위 실패 모드의 안전망
> - 파서는 **줄 단위로 try/catch** — 깨진 줄이 있어도 나머지는 살린다
> - 원본은 **더 완전한 쪽을 자동 선택**
> - 세션 보관 기본 30일(`cleanupPeriodDays`) 이후엔 세션 폴더의 `archive/` 사본만 남는다

> 상태 라벨(`완료`/`중단`/`진행중`)은 **INDEX 표에 적히는 표시용 글자**다. 동작을 바꾸지 않는다(중단으로 표시해도 백업은 계속됨).

## 동작 원리 (훅)

| 시점 | 훅 이벤트 | 하는 일 |
|------|-----------|---------|
| 세션 시작 | `SessionStart` (startup/resume/clear/fork) | 규칙 리마인더 + **이번 세션 고유 토큰** 주입 → INDEX 읽고 자기 handoff 파일 생성 |
| **압축 직전** | `PreCompact` (manual/auto) | ① 원본 `.jsonl` **백업**(최신 5) ② 무LLM **폴백요약** `fallback.md` ③ 복원 마커 남김 |
| **압축 직후** | `SessionStart` (compact) | 맥락 복원 리마인더 주입(+ "요약 말고 원본 재읽기" 지시) |
| **압축 후 첫 프롬프트** | `UserPromptSubmit` | 복원 마커 있으면 복원 리마인더 **재주입**(SessionStart 실패 대비) 후 마커 삭제 |
| 매 답변 끝 | `Stop` | 이 세션 `handoff.md` 가 **없을 때만** 만들라고 부드럽게 상기 |
| 세션 종료 | `SessionEnd` | `~/.claude/handoff-events.log`에 감사 기록 |

압축 후 컨텍스트에 텍스트를 주입할 수 있는 이벤트는 `SessionStart(compact)`가 기본이지만, 이 주입이 자동압축 때 누락되는 버그([#15174](https://github.com/anthropics/claude-code/issues/15174))가 있어 `UserPromptSubmit`로 **이중화**한다.

### 저장 층 (손실 관점)

| 층 | 누가 | 손실 | 정리 |
|----|------|------|------|
| 큐레이션 `<세션폴더>/handoff.md` | Claude가 요약 (`/handoff`) | 요약이라 세부 생략(연속성 유지) | 세션당 1 |
| 원본 `archive/compact-<시각>.jsonl` | 훅이 복사 (압축 직전) | 거의 무손실 | 최신 5개 |
| 원본 `archive/snap-<시각>.jsonl` | 사용자가 `/snapshot` | 거의 무손실 | 최신 3개(별도 관리) |
| 무LLM 폴백 `<세션폴더>/fallback.md` | 훅이 규칙 추출 | 뼈대만(항상 성공) | 덮어쓰기 1개 |

원칙: **비싼 이해 작업(요약)은 여유 있을 때 미리, 값싼 저장(원본 복사)은 마지막 순간에.**

## 파일 구조 (프로젝트마다 생성)

**세션 하나가 폴더 하나를 소유한다.** 그 세션에 관한 모든 게 그 안에 있고, 정리할 땐 폴더째 지우면 된다.

```
<프로젝트>/.handoff/                         # 전역 gitignore(**/.handoff/) 대상 — 커밋 안 됨
├── INDEX.md                                # 모든 세션 한 줄 요약(자기 줄만 갱신)
├── <주제>-<토큰>/                          # ← 세션 = 폴더 (자기 것만 쓴다)
│   ├── handoff.md                          # 큐레이션 요약 — /handoff 가 쓰는 것(사람이 읽음)
│   ├── fallback.md                         # 무LLM 폴백요약 — 가볍게 훑는 뼈대(덮어쓰기)
│   ├── restore-pending                     # 복원 마커(소비 즉시 삭제 · 자기청소)
│   ├── archive/
│   │   ├── compact-<시각>.jsonl            # 압축 직전 원본(최신 5개, 초과분 자동삭제)
│   │   └── snap-<시각>.jsonl               # /snapshot 수동 스냅샷(최신 3개, 자동백업과 분리)
│   └── restore/
│       ├── restore-full.md                 # /restore 무손실본 — 드릴다운 창고(항상 갱신)
│       ├── restore-normal.md               # /restore 기본 정제본(덮어쓰기)
│       └── restore-lite.md                 # /restore lite 정제본(덮어쓰기)
└── <다른주제>-<다른토큰>/                   # 동시에 도는 다른 세션 — 서로 안 건드림
```

- **세션식별자** = `<주제슬러그>-<세션토큰>` (예: `traffic-analysis-ba2968`). 토큰은 세션 UUID 앞 6자리라 동시 세션끼리 폴더가 절대 안 겹친다.
- 훅이 주제를 모른 채 먼저 만들면 폴더명이 토큰뿐(`ba2968/`)일 수 있다. `/handoff` 가 그때 `<주제>-<토큰>` 으로 **이름만 바꾼다**(내용은 그대로). 폴더는 항상 **토큰으로 찾으므로** 이름이 바뀌어도 계속 같은 폴더를 쓴다.
- **구버전(평면 구조)에서 올라오면 자동 이관된다** — `.handoff/.archive/<토큰>-*` 과 `.handoff/<주제>-<토큰>.md` 를 새 폴더로 **복사**한다(원본은 지우지 않는다). 폴더 이름은 구 파일의 주제를 물려받는다.
- **아티팩트 정리**: 자동백업 5개 · 수동 스냅샷 3개(서로 분리) · 요약/폴백 덮어쓰기 · 마커 자기청소. 무한히 쌓이는 건 없다. 유일한 append 파일은 `~/.claude/handoff-events.log`(이벤트당 1줄).

자세한 규칙은 [RULES.md](./RULES.md), 설계 배경/벤치마크는 [docs/PRIOR-ART.md](../../docs/PRIOR-ART.md) 참조.

## 왜 LLM 자동요약이 없나 (v1.3.0에서 제거)

v1.1.0에 `PreCompact` `type: agent` 훅으로 서브에이전트 자동요약을 넣었으나, 실제 압축에서 `Agent stop hooks are not yet supported outside REPL` 로 **실패**하고 프롬프트 전문을 화면에 쏟아내서 v1.3.0에서 제거했다. 대신 **무LLM 결정론 폴백**(`-fallback.md`)이 같은 역할을 공짜·즉시·항상성공으로 수행한다.

## 여러 세션이 왜 안 부딪히나

한 세션은 오직 **자기 파일 하나 + INDEX의 자기 줄 하나**만 쓴다. 세션마다 파일이 다르니 동일 파일 동시 쓰기가 없다. 시작할 때 `INDEX.md`만 먼저 읽어 겹치는 진행중 세션을 감지한다.

## FAQ

- **Q. 훅이 안 도는데요?** → Claude Code를 재시작했는지, `node`가 PATH에 있는지 확인. `~/.claude/handoff-events.log`에 기록이 남는지로 점검.
- **Q. `/handoff` 했는데 `.jsonl` 백업이 없어요.** → 정상이다. 원본 복사는 **압축될 때** 자동으로 되고, 원할 때 뜨려면 `/snapshot`을 쓴다. (원본 자체는 Claude Code가 `~/.claude/projects/`에 항상 보관 중)
- **Q. `Stop` 상기가 성가셔요.** → 세션 handoff 파일을 한 번 만들면(또는 `/handoff`) 조용해진다. 완전히 끄려면 `hooks.json`의 `Stop` 항목 제거.
- **Q. `.handoff/`가 git에 잡혀요.** → 전역 gitignore에 `**/.handoff/` 추가.

## 라이선스

[MIT](./LICENSE)
