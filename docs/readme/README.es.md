# QuidChat

[English](../../README.md) · [Bahasa Indonesia](README.id.md) · [Bahasa Melayu](README.ms.md) · [中文](README.zh.md) · [हिन्दी](README.hi.md) · **Español** · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

Un asistente de chat al que tus clientes pueden preguntar sobre **tus** productos y servicios, y que nunca se inventa nada.

Cada afirmación que hace sobre tu negocio sale de un documento que tú le diste, y muestra cuál. Cuando no tiene fuente, lo dice en vez de adivinar.

Se pone en tu web con una sola etiqueta `<script>`. WhatsApp, Telegram, Discord, Slack y LINE comparten el mismo núcleo.

> Esta página cubre todo lo necesario para poner en marcha y administrar QuidChat. Para lo más profundo — cómo funciona el aislamiento entre negocios, cómo está montada la búsqueda, por qué el almacenamiento es así — está el [README en inglés](../../README.md), que es la referencia completa.

---

## Empezar

```bash
pnpm install
pnpm build

export OPENAI_API_KEY=sk-...

# Crea un negocio y autoriza el sitio donde vivirá el widget
node packages/cli/dist/main.mjs init mi-tienda \
  --name "Mi Tienda" \
  --origin https://mitienda.example

# Dale algo con lo que responder
cat politica.txt | node packages/cli/dist/main.mjs add-text mi-tienda \
  --title "Política de la tienda" --stdin

# O apúntalo a una página que ya tienes
node packages/cli/dist/main.mjs add-url mi-tienda https://mitienda.example/envios \
  --title "Condiciones de envío"

# O lee el sitio entero — también desde el panel, en Conocimiento
node packages/cli/dist/main.mjs add-site mi-tienda https://mitienda.example --max-pages 25

node packages/cli/dist/main.mjs serve
```

El panel está en **http://localhost:3210/panel** — ahí vive toda la configuración, incluida la que arriba se pasó por línea de comandos. Habla diez idiomas y arranca en el del navegador. Ese es el idioma del panel, distinto del que leen tus clientes, que se define por negocio en Ajustes → Widget.

Después pega esto en el sitio que autorizaste:

```html
<script src="http://localhost:3210/quidchat.js"
        data-quidchat-tenant="mi-tienda"
        defer></script>
```

Pregúntale algo que tus documentos cubran y la respuesta llega con el nombre del documento.

## Por qué puedes fiarte de lo que responde

El modelo nunca responde de memoria sobre tu negocio. Cualquier frase que afirme un hecho sobre tu tienda tiene que apuntar a un fragmento de un documento que subiste; si no puede, la respuesta se rechaza antes de llegar al cliente y el asistente dice que eso todavía no lo sabe.

Los temas de riesgo — precios, descuentos, garantía, devoluciones, condiciones legales, existencias — nunca se responden por deducción. Solo con lo que tus documentos dicen literalmente.

Las preguntas rechazadas van a la pantalla **Sin responder**. Ahí lees la pregunta tal como la hizo el cliente y escribes la respuesta una vez; el siguiente que pregunte algo parecido ya la recibe.

## Darle conocimiento

Cuatro formas, todas en **Conocimiento** dentro del panel:

- **Pegar texto** — lo más rápido. Políticas, lista de precios, horarios.
- **Una página web** — se lee una vez y se puede releer cuando la cambies.
- **Un sitio entero** — sigue los enlaces desde una dirección de partida, respeta `robots.txt`, hasta 25 páginas por pasada. Cada página es su propia fuente con su propio título, para que la cita que ve el cliente diga «Condiciones de envío» y no el nombre de tu web.
- **Un PDF** — hasta unos 9 MB. Un PDF escaneado se rechaza con el motivo: sus letras son imágenes y necesita pasar por OCR.

## Canales

El widget web funciona desde el primer momento. Los demás son opcionales: sin credenciales, la dirección del webhook devuelve `404`, porque un negocio que solo usa el widget no debería tener un endpoint de WhatsApp abierto en su servidor.

Apunta la plataforma a `POST /v1/channels/:channel/:tenantSlug`.

| Canal | Qué hace falta |
|---|---|
| Telegram | token del bot, secreto del webhook |
| WhatsApp Cloud | phone number id, access token, app secret |
| WAHA (WhatsApp propio) | dirección de WAHA, nombre de sesión, API key |
| Discord | bot token, public key |
| Slack | bot token, signing secret |
| LINE | channel access token, channel secret |

Las credenciales se ponen en **Canales**, en el panel. Se cifran con `QUIDCHAT_SECRET_KEY` (`openssl rand -base64 32`) con AES-256-GCM, y el panel nunca vuelve a mostrar un valor guardado, ni siquiera enmascarado.

Configura también el secreto del webhook. La firma se verifica antes de analizar o guardar nada, así que una petición falsificada no llega al proceso: sin él, cualquiera que descubra la dirección puede meter palabras en tu historial y gastar tu presupuesto.

Un canal se puede **pausar** sin borrar sus credenciales, y la pausa detiene de verdad las respuestas, no solo cambia una etiqueta.

## Controlar el gasto

`monthly_budget_cents` es un límite duro: al alcanzarlo el asistente deja de responder en vez de seguir facturando. Cero significa sin límite, que no es lo mismo que gasto cero.

El modo de respuesta decide el coste:

- **static** — solo respuestas fijas aprobadas. Nunca llama a un modelo, así que sale gratis.
- **thrifty** — busca en tus documentos y responde con ellos.
- **full** — reformula la pregunta antes de buscar. Encuentra más y cuesta más.

También puedes usar un modelo en tu propia máquina con Ollama: sin clave, sin cuenta y sin que nada salga de tu servidor. Si QuidChat detecta uno ya funcionando en el mismo servidor, el panel te lo ofrece.

## Seguridad

- **El aislamiento entre negocios** es row-level security en la base de datos, no filtros en el código.
- **Los sitios permitidos** deciden quién puede abrir tu widget. Un sitio que no está en la lista se rechaza, y eso es lo que impide que otro incruste tu asistente y gaste tu presupuesto.
- **El token de administración** se compara en tiempo constante y los intentos fallidos se limitan por origen.
- **El panel** se niega a mostrarse dentro del marco de otra web y solo ejecuta sus propios scripts (`script-src 'self'`), porque ahí es donde vive el token.
- **Las credenciales** nunca se muestran de vuelta ni se guardan en texto plano.

## Guardar y respaldar

`retention_days` borra las conversaciones que pasan de esa edad. El servidor hace una pasada al arrancar y otra al día; `quidchat prune` la hace una vez y sale, para quien prefiera verlo en su propio cron.

Si un cliente pide hoy que borres lo suyo, usa eliminar la conversación en la pantalla **Conversaciones**: se lleva los mensajes, lo que el asistente citó y cualquier pregunta sin responder surgida de ahí.

`quidchat backup` escribe un solo archivo con todo: los documentos, las respuestas que aprobaste y cada conversación de tus clientes. Lo saca a través del motor de base de datos en marcha en vez de copiar el directorio — copiar archivos que Postgres tiene abiertos es justo como un respaldo acaba siendo irrecuperable el día que hace falta. En un Postgres gestionado, el comando imprime la línea de `pg_dump` que debes ejecutar.

## Configuración

| Variable | Por defecto | Significado |
|---|---|---|
| `PORT` | `3210` | `0` pide al sistema un puerto libre |
| `DATABASE_URL` | — | Postgres gestionado. Si no está, se usa PGlite incrustado |
| `QUIDCHAT_DATA_DIR` | `./.quidchat/data` | Dónde guarda PGlite. `memory` para no persistir |
| `QUIDCHAT_ADMIN_TOKEN` | — | Obligatorio para la API de administración; sin él, todas esas rutas rechazan |
| `QUIDCHAT_SECRET_KEY` | — | 32 bytes, base64 o hex. Cifra las credenciales guardadas en el panel |
| `QUIDCHAT_LOG` | `text` | Una línea por petición. `json` para procesar logs, `off` para nada |

El resto se configura en el panel: modelos, modo de respuesta, presupuesto, retención, temas de riesgo, sitios permitidos y el aspecto del widget.

## Licencia

MIT. Los detalles de desarrollo, la estructura de paquetes y cómo contribuir están en el [README en inglés](../../README.md).
