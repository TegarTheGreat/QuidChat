# QuidChat

[English](../../README.md) · [Bahasa Indonesia](README.id.md) · [Bahasa Melayu](README.ms.md) · **中文** · [हिन्दी](README.hi.md) · [Español](README.es.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

一个能回答顾客关于**你自己**产品和服务问题的聊天助手 —— 而且从不编造。

它关于你生意的每一句话都来自你给它的文档，并且会指出是哪一份。没有依据时，它会直说，而不是猜。

一个 `<script>` 标签就能放进你的网站。WhatsApp、Telegram、Discord、Slack 和 LINE 共用同一个内核。

> 这一页涵盖运行和管理 QuidChat 所需要的一切。更深入的部分 —— 租户隔离怎么做的、检索怎么组织的、存储怎么选的 —— 见[英文 README](../../README.md)，那是完整的参考。

---

## 快速开始

```bash
pnpm install
pnpm build

export OPENAI_API_KEY=sk-...

# 建一个商家，并允许挂件要放上去的那个网站
node packages/cli/dist/main.mjs init my-shop \
  --name "我的店" \
  --origin https://myshop.example

# 给它可以依据的内容
cat policy.txt | node packages/cli/dist/main.mjs add-text my-shop \
  --title "店铺政策" --stdin

# 或者直接指向你已有的页面
node packages/cli/dist/main.mjs add-url my-shop https://myshop.example/delivery \
  --title "配送说明"

# 或者读取整个网站 —— 后台「知识库」里也可以做
node packages/cli/dist/main.mjs add-site my-shop https://myshop.example --max-pages 25

node packages/cli/dist/main.mjs serve
```

后台在 **http://localhost:3210/panel** —— 所有设置都在那里，包括上面用命令行参数传的那些。后台支持十种语言，并会跟随浏览器的语言。那是后台的语言，与顾客看到的语言是两回事：后者在「设置 → 挂件」里按商家单独设定。

然后把这段贴进你刚才允许的网站：

```html
<script src="http://localhost:3210/quidchat.js"
        data-quidchat-tenant="my-shop"
        defer></script>
```

问一个你的文档里有的问题，答案会连同文档名称一起回来。

## 为什么它的回答可信

模型从不凭自己对你生意的印象回答。任何陈述你店铺事实的句子，都必须指向你上传的某段文档；指不出来，这条回答在到达顾客之前就被拒绝，助手会说这件事它还不知道。

高风险话题 —— 价格、折扣、保修、退款、法律条款、库存 —— 从不靠推断作答，只依据你文档里白纸黑字写着的内容。

被拒答的问题会进入**未能回答**页面。你在那里读到顾客的原话，写一次答复；下一个问类似问题的顾客就直接拿到它。

## 给它知识

四种方式，都在后台的**知识库**里：

- **粘贴文本** —— 最快。店铺政策、价目表、营业时间。
- **一个网页** —— 读一次，页面改了随时可以重读。
- **整个网站** —— 从一个起始地址跟随链接，遵守 `robots.txt`，一次最多 25 页。每一页是自己的一条来源，用自己的标题，这样顾客看到的出处写的是「配送说明」，而不是你的站名。
- **PDF 文件** —— 约 9 MB 以内。扫描版会连同原因一起被拒绝：它的文字是图像，得先过 OCR。

## 渠道

网站挂件开箱即用。其余是可选的 —— 没有凭据时 webhook 地址返回 `404`，因为只用挂件的商家不该在服务器上留一个无需认证的 WhatsApp 端点。

把平台指向 `POST /v1/channels/:channel/:tenantSlug`。

| 渠道 | 需要什么 |
|---|---|
| Telegram | bot token、webhook secret |
| WhatsApp Cloud | phone number id、access token、app secret |
| WAHA（自建 WhatsApp） | WAHA 地址、会话名、API key |
| Discord | bot token、public key |
| Slack | bot token、signing secret |
| LINE | channel access token、channel secret |

凭据填在后台的**渠道**里。它们都用 `QUIDCHAT_SECRET_KEY`（`openssl rand -base64 32`）以 AES-256-GCM 加密，后台从不把存下来的值显示回来，连打码的也不会。

webhook secret 也请一并填好。签名校验在任何解析和存储之前进行，伪造的请求进不了流程 —— 没有它，任何知道地址的人都能往你的会话记录里塞话，并花掉你的预算。

渠道可以**暂停**而不删除凭据，而且暂停是真的停止回答，不只是换个标签。

## 控制成本

`monthly_budget_cents` 是硬上限：到了以后助手停止回答，而不是继续产生账单。零表示不限，不等于不花钱。

回答模式决定成本：

- **static** —— 只用已批准的标准答复。从不调用模型，运行免费。
- **thrifty** —— 检索你的文档并据此回答。
- **full** —— 先改写问题再检索。找得更多，花得更多。

你也可以用 Ollama 跑在自己机器上的模型：不需要密钥和账号，数据不出你的服务器。如果 QuidChat 发现同一台服务器上已经有模型在跑，后台会主动提示。

## 安全

- **租户隔离**由数据库的行级安全实现，而不是应用代码里的过滤。
- **允许的网站**决定谁能打开你的挂件。不在名单上的站点会被拒绝，这正是别人无法把你的助手贴到自己站上并花光你预算的原因。
- **管理令牌**以恒定时间比较，猜错会按来源限流。
- **后台**拒绝被别人的页面框住，并且只运行自己的脚本（`script-src 'self'`），因为管理令牌就存在那里。
- **凭据**从不回显，也从不明文存储。

## 保存与备份

`retention_days` 会删除超期的会话。服务器启动时跑一次，之后每天一次；`quidchat prune` 跑一次就退出，方便你放进自己的 cron。

如果顾客今天就要求删除他的数据，用**会话**页面里的删除记录：它会删掉消息、引用的出处，以及由这段会话产生的未答记录。

`quidchat backup` 把所有东西写进一个文件：文档、你批准过的答复、每一段顾客会话。它通过正在运行的数据库引擎取快照，而不是复制目录 —— 复制 Postgres 正在打开的文件，正是备份在最需要它的时候变得无法恢复的原因。在托管 Postgres 上，这条命令会打印你该执行的 `pg_dump` 命令。

## 配置

| 变量 | 默认 | 含义 |
|---|---|---|
| `PORT` | `3210` | `0` 表示向系统要一个空闲端口 |
| `DATABASE_URL` | — | 托管 Postgres。不设则使用内嵌的 PGlite |
| `QUIDCHAT_DATA_DIR` | `./.quidchat/data` | PGlite 存数据的位置。`memory` 表示不落盘 |
| `QUIDCHAT_ADMIN_TOKEN` | — | 管理 API 必需；不设则所有管理路由一律拒绝 |
| `QUIDCHAT_SECRET_KEY` | — | 32 字节，base64 或 hex。用于加密后台里保存的凭据 |
| `QUIDCHAT_LOG` | `text` | 每个请求一行。`json` 便于日志解析，`off` 关闭 |

其余都在后台里设置：模型、回答模式、预算、保留期、高风险话题、允许的网站，以及挂件的外观。

## 许可

MIT。开发细节、包结构和贡献方式见[英文 README](../../README.md)。
