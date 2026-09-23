# 🧭 OpenClaw Session Router

OpenClaw 대시보드용 **세션 라우터** 확장 플러그인. 메시지를 받아 적절한 에이전트 세션으로 전달합니다.

- **수동 라우팅** (`session-router.route`) — 위젯에서 세션을 직접 골라 전송 (결정론적, API 키 불필요)
- **자동 라우팅** (`session-router.auto-route`) — Jev(TypeSafe System One)가 메시지를 읽고 목적지 세션을 판정.
  확신 `p ≥ 0.5` · `determined ≥ 0.5`면 즉시 전송, 미만이면 랭킹된 제안을 위젯에 돌려줘 **원클릭 확정**.
  Jev 호출 실패 시 **fail-open** — 추측하지 않고 수동 피커로 폴백.

외부 의존성 **0** — Node 18+ 내장 `fetch`만 사용하며 게이트웨이 프로세스 안에서 구동됩니다.

## 구성

```
├── index.js               ← 플러그인 엔트리 (게이트웨이 메서드 2개 등록)
├── openclaw.plugin.json   ← 매니페스트 (dashboard.actionVerbs 2개, operator.write)
├── env.example            ← TYPESAFE_API_KEY 템플릿
├── lib/
│   ├── route.js           ← 판단 프롬프트 빌더 + 수동/자동 핸들러 + 피드백 로그
│   └── jev.js             ← TypeSafe System One 클라이언트 (키 해석·시크릿 레딕션·8s 타임아웃)
├── widget/
│   └── session-router.html ← 대시보드 위젯 (수동 모드 + 🤖 Jev 자동 모드)
└── test/
    └── route.test.js      ← 단위 테스트
```

## 설치

요구사항: OpenClaw 게이트웨이, Node 18+. 자동 판정에만 `TYPESAFE_API_KEY` 필요 (수동 라우팅은 키 없이 동작).

```bash
# 1. 확장 디렉터리로 복사
git clone https://github.com/jkf87/openclaw-session-router.git
cp -r openclaw-session-router ~/.openclaw/extensions/session-router

# 2. (자동 판정용) 키 설정 — 둘 중 하나
#    a) 게이트웨이 환경변수에 TYPESAFE_API_KEY 설정
#    b) ~/.openclaw/workspace/.env 에 추가 (env.example 참조)
#       오버라이드: TYPESAFE_ENV_PATH 로 .env 경로 지정 가능

# 3. 레지스트리 갱신 + 활성화 (capability 동의 포함)
openclaw plugins registry --refresh
openclaw plugins enable session-router --accept-capabilities

# 4. 게이트웨이 재시작 후 로드 확인
openclaw plugins inspect session-router   # Status: enabled, Version: 1.0.0

# 5. 검증 (파라미터 검증 프로브 — 빈 메시지 에러가 떠야 정상)
openclaw gateway call session-router.route --params '{"message":""}' --json
```

⚠️ **재시작 타이밍 함정**: 위젯을 고정하기 전에 게이트웨이 재시작으로 `auto-route` 동사가
**활성 상태**인지 먼저 확인하세요. 동사가 살기 전에 고정한 위젯은 권한 부여가 기록되지 않아
`board widget action verb is not allowed` 에러가 납니다 → 이때는 위젯을 다시 고정하면 됩니다.

## 위젯 올리기

위젯은 파일로 두고 대상 환경의 에이전트에게 고정을 맡깁니다. 세션에 다음 프롬프트를 붙여넣으면 됩니다:

```text
widget/session-router.html 파일을 열어 그 내용으로 대시보드 위젯을 만들어 줘.
이름: session-router, 핀 고정, 크기 lg.
capabilities.tools: ["sessions.list", "agents.list",
                    "session-router.route", "session-router.auto-route"]
```

위젯 기능: 세션 목록(60초 자동갱신) · 검색 · 에이전트 칩 필터 · 수동 전송 ·
🤖 Jev 자동 판정(제안 세션에 "Jev 제안 p=0.xx" 배지 + 클릭 확정) · 전송 로그.

## 테스트

```bash
npm test
```

프롬프트 빌더(`buildRouteJudgment`), 판정 판독, 파라미터 검증, 피드백 로그 캡 등 28개 단위 테스트 포함.

## 작동 원리 요약

1. 위젯이 후보 세션(활동순 최대 20개)과 메시지를 `auto-route`로 보냄
2. `buildRouteJudgment`가 **투기적 헤드(speculative-heads)** 프롬프트를 조립 — 한 번의 왕복에
   `operation`(ROUTE/ASK_USER)과 `route_target`(목적지)을 동시에 질문
3. 임계값 통과 → `enqueueSystemEvent` + `requestHeartbeat` 로 즉시 전달
4. 미달 → `needs_pick` + 제안 반환 → 위젯에서 원클릭 확정 (확정은 `feedback`로 기록됨)

전달 시 세션에 들어가는 텍스트:
`[Session Router] 사용자가 대시보드에서 이 세션으로 메시지를 보냈습니다:`

피드백 로그: `~/.openclaw/extensions/session-router/state/route-feedback.jsonl` (최근 200줄, 관찰 전용)

## 커스터마이징

- **메서드 이름 변경**: `lib/route.js` 상단의 `ROUTE_METHOD`/`AUTO_ROUTE_METHOD` 상수와
  `openclaw.plugin.json`의 `method` 필드, 위젯 안의 `openclaw.action.run(...)` 인자를 함께 바꾸면 됩니다.
- **자동 전송 임계값**: `lib/route.js`의 `AUTO_PROBABILITY`/`AUTO_DETERMINED` (기본 0.5/0.5.
  더 보수적으로 쓰려면 0.9/0.9로 올리세요).
- **후보 수**: 위젯의 `candidatesPayload()` (20개)와 `lib/route.js`의 `MAX_CANDIDATES` (25개).

## 라이선스

[MIT](LICENSE)
