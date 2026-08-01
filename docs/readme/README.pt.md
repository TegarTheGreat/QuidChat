# QuidChat

[English](../../README.md) · [Bahasa Indonesia](README.id.md) · [Bahasa Melayu](README.ms.md) · [中文](README.zh.md) · [हिन्दी](README.hi.md) · [Español](README.es.md) · **Português** · [Русский](README.ru.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

Um assistente de chat que seus clientes podem perguntar sobre **os seus** produtos e serviços — e que nunca inventa nada.

Cada afirmação que ele faz sobre o seu negócio vem de um documento que você deu, e ele mostra qual. Quando não tem fonte, ele diz isso em vez de adivinhar.

Entra no seu site com uma única tag `<script>`. WhatsApp, Telegram, Discord, Slack e LINE usam o mesmo núcleo.

> Esta página cobre tudo o que é preciso para rodar e administrar o QuidChat. Para as partes mais profundas — como funciona o isolamento entre negócios, como a busca é montada, por que o armazenamento é assim — veja o [README em inglês](../../README.md), que é a referência completa.

---

## Começando

```bash
pnpm install
pnpm build

export OPENAI_API_KEY=sk-...

# Crie um negócio e libere o site onde o widget vai ficar
node packages/cli/dist/main.mjs init minha-loja \
  --name "Minha Loja" \
  --origin https://minhaloja.example

# Dê a ele algo com que responder
cat politica.txt | node packages/cli/dist/main.mjs add-text minha-loja \
  --title "Política da loja" --stdin

# Ou aponte para uma página que você já tem
node packages/cli/dist/main.mjs add-url minha-loja https://minhaloja.example/entrega \
  --title "Condições de entrega"

# Ou leia o site inteiro — também dá pelo painel, em Conhecimento
node packages/cli/dist/main.mjs add-site minha-loja https://minhaloja.example --max-pages 25

node packages/cli/dist/main.mjs serve
```

O painel fica em **http://localhost:3210/panel** — toda a configuração mora ali, inclusive a que acima foi passada por linha de comando. Ele fala dez idiomas e começa no do navegador. Esse é o idioma do painel, diferente do que seus clientes leem, definido por negócio em Configurações → Widget.

Depois cole isto no site que você liberou:

```html
<script src="http://localhost:3210/quidchat.js"
        data-quidchat-tenant="minha-loja"
        defer></script>
```

Pergunte algo que seus documentos cobrem e a resposta chega com o nome do documento junto.

## Por que dá para confiar na resposta

O modelo nunca responde de memória sobre o seu negócio. Qualquer frase que afirme um fato sobre a sua loja precisa apontar para um trecho de documento que você subiu; se não conseguir, a resposta é recusada antes de chegar ao cliente e o assistente diz que ainda não sabe.

Assuntos de risco — preço, desconto, garantia, reembolso, condições legais, estoque — nunca são respondidos por dedução. Só pelo que está escrito nos seus documentos.

As perguntas recusadas vão para a tela **Sem resposta**. Ali você lê a pergunta como o cliente fez e escreve a resposta uma vez; o próximo que perguntar algo parecido já recebe.

## Dando conhecimento

Quatro caminhos, todos em **Conhecimento** no painel:

- **Colar texto** — o mais rápido. Política da loja, tabela de preços, horário.
- **Uma página web** — lida uma vez, e relida quando você mudar a página.
- **Um site inteiro** — segue os links a partir de um endereço, respeita o `robots.txt`, até 25 páginas por vez. Cada página vira uma fonte própria com título próprio, para que a citação que o cliente vê diga "Condições de entrega" e não o nome do seu site.
- **Um PDF** — até uns 9 MB. PDF escaneado é recusado com o motivo: as letras são imagens e precisam passar por OCR.

## Canais

O widget do site funciona de cara. Os outros são opcionais — sem credenciais, o endereço do webhook responde `404`, porque um negócio que só usa o widget não deveria ter um endpoint de WhatsApp aberto no servidor.

Aponte a plataforma para `POST /v1/channels/:channel/:tenantSlug`.

| Canal | O que é preciso |
|---|---|
| Telegram | token do bot, segredo do webhook |
| WhatsApp Cloud | phone number id, access token, app secret |
| WAHA (WhatsApp próprio) | endereço do WAHA, nome da sessão, API key |
| Discord | bot token, public key |
| Slack | bot token, signing secret |
| LINE | channel access token, channel secret |

As credenciais vão em **Canais**, no painel. Tudo é cifrado com `QUIDCHAT_SECRET_KEY` (`openssl rand -base64 32`) usando AES-256-GCM, e o painel nunca mostra de volta um valor guardado, nem mascarado.

Configure também o segredo do webhook. A assinatura é verificada antes de qualquer coisa ser analisada ou salva, então uma requisição forjada não chega ao fluxo — sem ele, quem descobrir o endereço pode colocar palavras no seu histórico de conversas e gastar seu orçamento.

Um canal pode ser **pausado** sem apagar as credenciais, e a pausa realmente para as respostas, não muda só um rótulo.

## Controlando o custo

`monthly_budget_cents` é um limite rígido: ao ser atingido, o assistente para de responder em vez de continuar gerando conta. Zero significa sem limite, o que não é o mesmo que gasto zero.

O modo de resposta decide o custo:

- **static** — só respostas prontas aprovadas. Nunca chama um modelo, então roda de graça.
- **thrifty** — busca nos seus documentos e responde com eles.
- **full** — reescreve a pergunta antes de buscar. Acha mais e custa mais.

Você também pode usar um modelo na sua própria máquina com o Ollama: sem chave, sem conta e sem nada saindo do seu servidor. Se o QuidChat perceber um já rodando no mesmo servidor, o painel oferece.

## Segurança

- **O isolamento entre negócios** é row-level security no banco, não filtro no código da aplicação.
- **Os sites permitidos** decidem quem pode abrir o seu widget. Um site fora da lista é recusado, e é isso que impede alguém de incorporar o seu assistente e gastar o seu orçamento.
- **O token de administração** é comparado em tempo constante, e tentativas erradas são limitadas por origem.
- **O painel** se recusa a aparecer dentro do frame de outro site e só executa os próprios scripts (`script-src 'self'`), porque é ali que o token fica.
- **As credenciais** nunca são exibidas de volta nem guardadas em texto puro.

## Guardar e fazer backup

`retention_days` apaga as conversas que passam desse tempo. O servidor faz uma passada ao iniciar e outra por dia; `quidchat prune` faz uma vez e sai, para quem prefere colocar no próprio cron.

Se um cliente pedir hoje para apagar o que você guarda sobre ele, use excluir a conversa na tela **Conversas** — vai junto cada mensagem, o que o assistente citou e qualquer pergunta sem resposta surgida dali.

`quidchat backup` escreve um arquivo só com tudo: os documentos, as respostas que você aprovou e cada conversa de cliente. Ele tira a cópia pelo próprio motor do banco em vez de copiar o diretório — copiar arquivos que o Postgres tem abertos é justamente como um backup acaba irrecuperável no dia em que se precisa dele. Num Postgres gerenciado, o comando imprime a linha de `pg_dump` que você deve rodar.

## Configuração

| Variável | Padrão | Significado |
|---|---|---|
| `PORT` | `3210` | `0` pede uma porta livre ao sistema |
| `DATABASE_URL` | — | Postgres gerenciado. Sem ela, usa o PGlite embutido |
| `QUIDCHAT_DATA_DIR` | `./.quidchat/data` | Onde o PGlite guarda os dados. `memory` para não persistir |
| `QUIDCHAT_ADMIN_TOKEN` | — | Obrigatório para a API de administração; sem ele, essas rotas recusam |
| `QUIDCHAT_SECRET_KEY` | — | 32 bytes, base64 ou hex. Cifra as credenciais salvas no painel |
| `QUIDCHAT_LOG` | `text` | Uma linha por requisição. `json` para processar logs, `off` para nenhuma |

O resto é configurado no painel: modelos, modo de resposta, orçamento, retenção, assuntos de risco, sites permitidos e a aparência do widget.

## Licença

MIT. Detalhes de desenvolvimento, estrutura de pacotes e como contribuir estão no [README em inglês](../../README.md).
