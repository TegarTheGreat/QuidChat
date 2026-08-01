# QuidChat

[English](../../README.md) · [Bahasa Indonesia](README.id.md) · **Bahasa Melayu** · [中文](README.zh.md) · [हिन्दी](README.hi.md) · [Español](README.es.md) · [Português](README.pt.md) · [Русский](README.ru.md) · [日本語](README.ja.md) · [한국어](README.ko.md)

Pembantu sembang yang boleh ditanya pelanggan tentang **produk dan perkhidmatan anda sendiri** — dan tidak pernah mereka-reka.

Setiap kenyataan tentang perniagaan anda datang daripada dokumen yang anda berikan, dan ia menunjukkan yang mana satu. Apabila tiada sumbernya, ia berkata begitu dan bukannya meneka.

Letakkannya pada laman anda dengan satu tag `<script>`. WhatsApp, Telegram, Discord, Slack dan LINE berkongsi teras yang sama.

> Halaman ini merangkumi semua yang diperlukan untuk menjalankan dan mengurus QuidChat. Untuk bahagian yang lebih mendalam — bagaimana pengasingan antara perniagaan berfungsi, bagaimana carian disusun, mengapa penyimpanannya begitu — rujuk [README bahasa Inggeris](../../README.md), yang menjadi rujukan penuhnya.

---

## Mula pantas

```bash
pnpm install
pnpm build

export OPENAI_API_KEY=sk-...

# Cipta satu perniagaan, dan benarkan laman tempat widget akan diletakkan
node packages/cli/dist/main.mjs init kedai-saya \
  --name "Kedai Saya" \
  --origin https://kedaisaya.example

# Beri sesuatu untuk dijawab
cat polisi.txt | node packages/cli/dist/main.mjs add-text kedai-saya \
  --title "Polisi Kedai" --stdin

# Atau halakan ke halaman yang sedia ada
node packages/cli/dist/main.mjs add-url kedai-saya https://kedaisaya.example/penghantaran \
  --title "Syarat penghantaran"

# Atau baca seluruh laman — juga boleh dari papan pemuka, di bawah Pengetahuan
node packages/cli/dist/main.mjs add-site kedai-saya https://kedaisaya.example --max-pages 25

node packages/cli/dist/main.mjs serve
```

Papan pemuka ada di **http://localhost:3210/panel** — semua tetapan ada di sana, termasuk yang di atas dihantar sebagai flag. Ia bertutur dalam sepuluh bahasa dan bermula dengan bahasa pelayar anda. Itu bahasa papan pemuka, berlainan daripada bahasa yang dibaca pelanggan anda, yang ditetapkan bagi setiap perniagaan di Tetapan → Widget.

Kemudian tampal ini ke laman yang tadi anda benarkan:

```html
<script src="http://localhost:3210/quidchat.js"
        data-quidchat-tenant="kedai-saya"
        defer></script>
```

Tanya sesuatu yang ada dalam dokumen anda, dan jawapannya tiba berserta nama dokumennya.

## Kenapa jawapannya boleh dipercayai

Model tidak pernah menjawab daripada ingatannya sendiri tentang perniagaan anda. Mana-mana ayat yang menyatakan fakta tentang kedai anda mesti menunjuk kepada petikan dokumen yang anda muat naik; jika tidak boleh, jawapan itu ditolak sebelum sampai kepada pelanggan, dan pembantu memberitahu bahawa maklumat itu belum ada.

Topik berisiko tinggi — harga, diskaun, jaminan, bayaran balik, terma undang-undang, stok — tidak pernah dijawab secara agakan. Hanya daripada apa yang tertulis jelas dalam dokumen anda.

Soalan yang ditolak masuk ke skrin **Belum terjawab**. Di situ anda membaca soalan sebenar pelanggan dan menulis jawapannya sekali; pelanggan berikutnya yang bertanya perkara serupa terus mendapatnya.

## Memberikan pengetahuan

Empat cara, semuanya di **Pengetahuan** dalam papan pemuka:

- **Tampal teks** — paling pantas. Polisi kedai, senarai harga, waktu operasi.
- **Satu halaman web** — dibaca sekali, dan boleh dibaca semula bila-bila halaman itu berubah.
- **Seluruh laman** — mengikut pautan dari satu alamat permulaan, mematuhi `robots.txt`, sehingga 25 halaman sekali jalan. Setiap halaman menjadi sumbernya sendiri dengan tajuknya sendiri, supaya rujukan yang dilihat pelanggan berbunyi "Syarat penghantaran", bukan nama laman anda.
- **Fail PDF** — sehingga kira-kira 9 MB. PDF hasil imbasan ditolak berserta sebabnya: hurufnya ialah gambar dan perlu melalui OCR dahulu.

## Saluran

Widget laman web berfungsi terus. Selebihnya pilihan — tanpa kelayakan, alamat webhook membalas `404`, kerana perniagaan yang hanya guna widget tidak sepatutnya mempunyai endpoint WhatsApp terbuka pada pelayannya.

Halakan platform ke `POST /v1/channels/:channel/:tenantSlug`.

| Saluran | Apa yang diperlukan |
|---|---|
| Telegram | token bot, webhook secret |
| WhatsApp Cloud | phone number id, access token, app secret |
| WAHA (WhatsApp sendiri) | alamat WAHA, nama sesi, API key |
| Discord | bot token, public key |
| Slack | bot token, signing secret |
| LINE | channel access token, channel secret |

Kelayakan diisi di **Saluran** dalam papan pemuka. Semuanya disulitkan dengan `QUIDCHAT_SECRET_KEY` (`openssl rand -base64 32`) menggunakan AES-256-GCM, dan papan pemuka tidak pernah memaparkan semula nilai yang tersimpan — walaupun yang ditutup sebahagian.

Isikan juga webhook secret. Pengesahan tandatangan dijalankan sebelum apa-apa dihurai atau disimpan, jadi permintaan palsu tidak sampai ke aliran — tanpanya, sesiapa yang tahu alamat itu boleh menyelitkan ayat ke dalam sejarah perbualan anda dan menghabiskan bajet anda.

Saluran boleh **dijeda** tanpa memadam kelayakannya, dan jeda itu benar-benar menghentikan jawapan, bukan sekadar menukar label.

## Mengawal kos

`monthly_budget_cents` ialah had keras: setelah dicapai, pembantu berhenti menjawab dan bukannya terus menambah bil. Sifar bermakna tiada had — bukan tiada perbelanjaan.

Mod jawapan menentukan kosnya:

- **static** — hanya jawapan sedia ada yang diluluskan. Tidak pernah memanggil model, jadi percuma dijalankan.
- **thrifty** — mencari dalam dokumen anda dan menjawab daripadanya.
- **full** — menulis semula soalan dahulu, kemudian mencari. Menemui lebih banyak, kosnya lebih tinggi.

Anda juga boleh menggunakan model pada mesin sendiri melalui Ollama: tanpa kunci, tanpa akaun, dan tiada data keluar dari pelayan anda. Jika QuidChat mengesan model yang sudah berjalan pada pelayan yang sama, papan pemuka akan menawarkannya.

## Keselamatan

- **Pengasingan antara perniagaan** menggunakan row-level security dalam pangkalan data, bukan penapisan dalam kod aplikasi.
- **Laman yang dibenarkan** menentukan siapa boleh membuka widget anda. Laman yang tiada dalam senarai ditolak, dan itulah yang menghalang orang lain menampal pembantu anda pada lamannya lalu menghabiskan bajet anda.
- **Token pentadbir** dibandingkan dalam masa tetap, dan tekaan yang salah dihadkan mengikut sumber.
- **Papan pemuka** enggan dipaparkan di dalam bingkai laman lain dan hanya menjalankan skripnya sendiri (`script-src 'self'`), kerana di situlah token itu berada.
- **Kelayakan** tidak pernah dipaparkan semula, dan tidak pernah disimpan sebagai teks biasa.

## Menyimpan dan menyandar

`retention_days` memadam perbualan yang melepasi tempohnya. Pelayan menjalankannya semasa mula dan sekali sehari; `quidchat prune` melakukannya sekali lalu keluar, untuk sesiapa yang mahu meletakkannya dalam cron sendiri.

Jika pelanggan meminta datanya dipadam hari ini, gunakan padam transkrip pada skrin **Perbualan** — ia membawa pergi mesejnya, sumber yang dipetik, dan sebarang soalan tidak terjawab yang timbul daripadanya.

`quidchat backup` menulis satu fail yang mengandungi semuanya: dokumen, jawapan yang anda luluskan, dan setiap perbualan pelanggan. Ia mengambil salinan melalui enjin pangkalan data yang sedang berjalan dan bukannya menyalin direktori — menyalin fail yang sedang dibuka Postgres ialah cara sandaran menjadi tidak boleh dipulihkan pada hari ia diperlukan. Pada Postgres terurus, arahan itu mencetak baris `pg_dump` yang perlu anda jalankan.

## Konfigurasi

| Pemboleh ubah | Lalai | Maksud |
|---|---|---|
| `PORT` | `3210` | `0` meminta port kosong daripada sistem |
| `DATABASE_URL` | — | Postgres terurus. Jika tiada, PGlite terbenam digunakan |
| `QUIDCHAT_DATA_DIR` | `./.quidchat/data` | Tempat PGlite menyimpan data. `memory` untuk sementara |
| `QUIDCHAT_ADMIN_TOKEN` | — | Wajib untuk API pentadbir; tanpanya semua laluan itu menolak |
| `QUIDCHAT_SECRET_KEY` | — | 32 bait, base64 atau hex. Menyulitkan kelayakan yang disimpan dalam papan pemuka |
| `QUIDCHAT_LOG` | `text` | Satu baris bagi setiap permintaan. `json` untuk pemproses log, `off` untuk tiada |

Selebihnya ditetapkan dalam papan pemuka: model, mod jawapan, bajet, tempoh simpan, topik berisiko, laman yang dibenarkan, dan rupa widget.

## Lesen

MIT. Butiran pembangunan, struktur pakej dan cara menyumbang ada dalam [README bahasa Inggeris](../../README.md).
