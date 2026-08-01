# QuidChat

[English](../../README.md) · [Bahasa Indonesia](README.id.md) · [Bahasa Melayu](README.ms.md) · [中文](README.zh.md) · [हिन्दी](README.hi.md) · [Español](README.es.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · **한국어**

**당신의** 상품과 서비스에 대해 고객이 물어볼 수 있는 챗 어시스턴트 — 그리고 절대 지어내지 않습니다.

당신의 사업에 관해 하는 모든 말은 당신이 준 문서에서 나오고, 어느 문서인지도 보여 줍니다. 근거가 없으면 짐작하는 대신 없다고 말합니다.

`<script>` 태그 하나로 사이트에 올라갑니다. WhatsApp, Telegram, Discord, Slack, LINE 모두 같은 핵심을 씁니다.

> 이 페이지에는 QuidChat을 돌리고 운영하는 데 필요한 것이 모두 있습니다. 더 깊은 부분 — 테넌트 격리가 어떻게 되는지, 검색이 어떻게 짜였는지, 저장소를 왜 그렇게 골랐는지 — 는 [영어 README](../../README.md)에 있으며, 그쪽이 완전한 참고 문서입니다.

---

## 빠르게 시작하기

```bash
pnpm install
pnpm build

export OPENAI_API_KEY=sk-...

# 사업체를 하나 만들고, 위젯이 놓일 사이트를 허용합니다
node packages/cli/dist/main.mjs init nae-gage \
  --name "우리 가게" \
  --origin https://gage.example

# 답할 근거를 줍니다
cat policy.txt | node packages/cli/dist/main.mjs add-text nae-gage \
  --title "매장 정책" --stdin

# 이미 있는 페이지를 가리켜도 됩니다
node packages/cli/dist/main.mjs add-url nae-gage https://gage.example/baesong \
  --title "배송 안내"

# 사이트 전체를 읽힐 수도 있습니다 — 관리 화면의 "지식"에서도 됩니다
node packages/cli/dist/main.mjs add-site nae-gage https://gage.example --max-pages 25

node packages/cli/dist/main.mjs serve
```

관리 화면은 **http://localhost:3210/panel** 에 있습니다. 모든 설정이 거기 있고, 위에서 플래그로 넘긴 것들도 마찬가지입니다. 화면은 열 개 언어를 지원하며 브라우저 언어로 열립니다. 그것은 관리 화면의 언어이고, 고객이 읽는 언어는 별개로 설정 → 위젯에서 사업체마다 정합니다.

그다음 허용한 사이트에 이걸 붙여 넣습니다:

```html
<script src="http://localhost:3210/quidchat.js"
        data-quidchat-tenant="nae-gage"
        defer></script>
```

문서에 있는 내용을 물어보면, 답이 문서 이름과 함께 옵니다.

## 답을 믿을 수 있는 이유

모델이 당신의 사업에 대해 기억으로 답하는 일은 없습니다. 가게에 관한 사실을 말하는 문장은 반드시 당신이 올린 문서의 한 조각을 가리켜야 하고, 가리키지 못하면 그 답은 고객에게 닿기 전에 막히며 어시스턴트는 아직 모른다고 말합니다.

위험이 큰 주제 — 가격, 할인, 보증, 환불, 법적 조건, 재고 — 는 추론으로 답하지 않습니다. 문서에 분명히 적힌 것만 씁니다.

거절된 질문은 **답하지 못한 질문** 화면으로 모입니다. 거기서 고객이 쓴 그대로의 질문을 읽고 답을 한 번 쓰면, 다음에 비슷하게 묻는 고객은 바로 그 답을 받습니다.

## 지식 넣기

네 가지 방법이며 모두 관리 화면의 **지식**에 있습니다.

- **글 붙여넣기** — 가장 빠릅니다. 매장 정책, 가격표, 영업시간.
- **웹페이지 한 장** — 한 번 읽고, 페이지가 바뀌면 언제든 다시 읽힐 수 있습니다.
- **사이트 전체** — 시작 주소에서 링크를 따라가며 `robots.txt`를 지키고, 한 번에 최대 25쪽까지. 각 페이지가 자기 제목을 단 별개의 자료가 되어, 고객이 보는 출처가 사이트 이름이 아니라 "배송 안내"라고 적힙니다.
- **PDF 파일** — 약 9MB까지. 스캔한 PDF는 이유와 함께 거절됩니다. 글자가 그림이라 먼저 OCR이 필요합니다.

## 채널

웹사이트 위젯은 바로 됩니다. 나머지는 선택입니다 — 인증 정보가 없으면 webhook 주소는 `404`를 돌려줍니다. 위젯만 쓰는 사업체의 서버에 인증 없는 WhatsApp 입구가 열려 있을 이유가 없기 때문입니다.

플랫폼을 `POST /v1/channels/:channel/:tenantSlug` 로 향하게 하세요.

| 채널 | 필요한 것 |
|---|---|
| Telegram | bot token, webhook secret |
| WhatsApp Cloud | phone number id, access token, app secret |
| WAHA (직접 운영하는 WhatsApp) | WAHA 주소, 세션 이름, API key |
| Discord | bot token, public key |
| Slack | bot token, signing secret |
| LINE | channel access token, channel secret |

인증 정보는 관리 화면의 **채널**에 넣습니다. 모두 `QUIDCHAT_SECRET_KEY`(`openssl rand -base64 32`)로 AES-256-GCM 암호화되며, 관리 화면은 저장된 값을 가려서라도 다시 보여 주지 않습니다.

webhook secret도 함께 설정하세요. 서명 검증은 무엇을 파싱하거나 저장하기 전에 이뤄지므로 위조된 요청은 처리에 닿지 않습니다. 이것이 없으면 주소를 알아낸 누구든 대화 기록에 말을 끼워 넣고 예산을 쓸 수 있습니다.

채널은 인증 정보를 지우지 않고 **일시 중지**할 수 있고, 그 중지는 라벨만 바꾸는 게 아니라 실제로 응답을 멈춥니다.

## 비용 관리

`monthly_budget_cents` 는 단단한 상한입니다. 도달하면 청구를 계속 쌓는 대신 어시스턴트가 응답을 멈춥니다. 0은 상한 없음이지 지출 0이 아닙니다.

답변 모드가 비용을 정합니다.

- **static** — 승인된 정형 답변만. 모델을 한 번도 부르지 않으니 운영이 무료입니다.
- **thrifty** — 문서를 검색해 거기서 답합니다.
- **full** — 질문을 먼저 다시 쓰고 검색합니다. 더 많이 찾고 비용도 더 듭니다.

Ollama로 자기 기계에서 도는 모델을 쓸 수도 있습니다. 키도 계정도 필요 없고 데이터가 서버 밖으로 나가지 않습니다. 같은 서버에서 이미 모델이 돌고 있으면 관리 화면이 이를 알아보고 권합니다.

## 보안

- **테넌트 격리**는 애플리케이션 코드의 필터가 아니라 데이터베이스의 row-level security로 합니다.
- **허용한 사이트**가 누가 위젯을 열 수 있는지를 정합니다. 목록에 없는 사이트는 거절되며, 그것이 남이 당신의 어시스턴트를 자기 사이트에 붙여 예산을 쓰는 일을 막습니다.
- **관리 토큰**은 일정 시간으로 비교하고, 틀린 시도는 출처별로 제한합니다.
- **관리 화면**은 남의 사이트 프레임 안에 뜨기를 거부하고 자기 스크립트만 실행합니다(`script-src 'self'`). 토큰이 거기 있기 때문입니다.
- **인증 정보**는 다시 보여 주지도, 평문으로 저장하지도 않습니다.

## 보관과 백업

`retention_days` 는 기한이 지난 대화를 지웁니다. 서버는 시작할 때와 하루 한 번 이를 실행하고, `quidchat prune` 은 한 번 하고 끝납니다. 자기 cron에 넣고 싶은 사람을 위한 것입니다.

고객이 오늘 자기 데이터를 지워 달라고 하면 **대화** 화면의 기록 삭제를 쓰세요. 메시지, 어시스턴트가 인용한 출처, 그 대화에서 생긴 미답변 기록까지 함께 사라집니다.

`quidchat backup` 은 모든 것을 한 파일에 씁니다. 문서, 당신이 승인한 답변, 그리고 모든 고객 대화입니다. 디렉터리를 복사하는 대신 돌아가는 데이터베이스 엔진을 통해 뽑습니다. Postgres가 열어 둔 파일을 복사하는 것이야말로 정작 필요한 날 복원되지 않는 백업이 만들어지는 방식이기 때문입니다. 관리형 Postgres에서는 실행해야 할 `pg_dump` 명령을 출력합니다.

## 설정

| 변수 | 기본값 | 뜻 |
|---|---|---|
| `PORT` | `3210` | `0` 이면 운영체제에 빈 포트를 요청 |
| `DATABASE_URL` | — | 관리형 Postgres. 없으면 내장 PGlite |
| `QUIDCHAT_DATA_DIR` | `./.quidchat/data` | PGlite 저장 위치. `memory` 면 남기지 않음 |
| `QUIDCHAT_ADMIN_TOKEN` | — | 관리 API에 필수. 없으면 관리 경로 전부 거절 |
| `QUIDCHAT_SECRET_KEY` | — | 32바이트, base64 또는 hex. 관리 화면에 저장한 인증 정보를 암호화 |
| `QUIDCHAT_LOG` | `text` | 요청당 한 줄. 로그를 파싱하려면 `json`, 끄려면 `off` |

나머지는 관리 화면에서 정합니다. 모델, 답변 모드, 예산, 보관 기간, 위험 주제, 허용 사이트, 위젯 모양.

## 라이선스

MIT. 개발 관련 내용, 패키지 구조, 기여 방법은 [영어 README](../../README.md)에 있습니다.
