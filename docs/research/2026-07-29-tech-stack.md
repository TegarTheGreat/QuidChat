# Riset Tech Stack QuidChat

**Tanggal:** 2026-07-29
**Status:** Riset selesai — menunggu keputusan arsitektur
**Target pengguna:** beginner → enthusiast → perusahaan. Wajib solid untuk produksi, mudah dipakai, universal.

---

## 1. Metodologi

Semua angka bintang, bahasa, dan lisensi diambil langsung dari **GitHub API** (`api.github.com/repos/...`), bukan dari artikel blog. Tech stack diverifikasi dari `package.json` / `pyproject.toml` asli di branch default masing-masing repo. Beberapa hasil pencarian awal berisi halaman SEO buatan AI dengan klaim yang tidak akurat — semua klaim di dokumen ini punya sumber primer.

Yang **tidak** diverifikasi langsung dan ditandai sebagai perkiraan: performa vector database (dari benchmark pihak ketiga) dan tren adopsi bahasa.

---

## 2. Lanskap proyek pembanding

| Proyek | Bahasa | Bintang | Lisensi | Dibuat | Kategori |
|---|---|---:|---|---|---|
| [openclaw/openclaw](https://github.com/openclaw/openclaw) | TypeScript | 384.486 | MIT | 2025-11 | Personal AI assistant / multi-channel gateway |
| [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) | Python | 222.299 | MIT | 2025-07 | Self-improving agent, persistent memory |
| [paperclipai/paperclip](https://github.com/paperclipai/paperclip) | TypeScript | 75.090 | MIT | 2026-03 | Orkestrator tim agent |
| [666ghj/MiroFish](https://github.com/666ghj/MiroFish) | Python | 69.680 | **AGPL-3.0** | 2025-11 | Swarm simulation / prediction engine |
| [opencode](https://opencode.ai) (`sst/opencode`) | TypeScript | — | MIT | 2025 | Coding agent (TUI + desktop) |
| [camel-ai/oasis](https://github.com/camel-ai/oasis) | Python | 4.972 | Apache-2.0 | 2024-11 | Engine simulasi di bawah MiroFish |
| 9Router | JavaScript | ~24rb | — | 2026 | LLM router, OpenAI-compatible API |

**Catatan penting soal `opencode`:** ada dua repo dengan nama sama. `opencode-ai/opencode` (Go, 13.591 bintang) **sudah tidak aktif** — commit terakhir 2025-09-18. Yang aktif adalah `sst/opencode` (TypeScript), yang URL API-nya sudah dipindah. Jangan sampai salah rujukan.

**Catatan lisensi:**
- OpenClaw terbaca `NOASSERTION` di GitHub API, tapi file `LICENSE`-nya **MIT** (© OpenClaw Foundation) dan `package.json` menyatakan `"license": "MIT"`. Kemungkinan ada `THIRD_PARTY_NOTICES.md` yang membuat detektor lisensi GitHub ragu.
- **MiroFish AGPL-3.0** — ini viral license. Kalau QuidChat mengambil kode dari MiroFish, QuidChat wajib AGPL juga. QuidChat sudah MIT, jadi **MiroFish hanya boleh jadi referensi ide, bukan sumber kode**.

---

## 3. Tech stack yang terverifikasi

### 3.1 OpenClaw — pembanding paling relevan (TypeScript, 384rb bintang)

Dari `package.json` (versi `2026.7.2`, versioning berbasis tanggal):

| Lapisan | Pilihan |
|---|---|
| Runtime | Node.js `>=22.22.3` (juga menerima 24.x / 25.x) |
| Package manager | **pnpm 11** (workspace / monorepo) |
| Query builder | **kysely** `0.29.4` — bukan ORM penuh |
| Vector store | **`sqlite-vec` 0.1.9 (optionalDependency)** — tertanam, bukan server |
| Protokol tool | `@modelcontextprotocol/sdk` (MCP) `1.30.0` |
| Protokol klien | `@agentclientprotocol/sdk` (ACP) `1.3.0` |
| LLM providers | SDK langsung per provider: `@anthropic-ai/sdk`, `openai`, `@google/genai`, `@mistralai/mistralai` |
| HTTP server | `express` 5.2.1 |
| Channel | `grammy` (Telegram) + `@grammyjs/runner`, `@grammyjs/transformer-throttler` |
| Scheduler | `croner` 10.0.1 |
| Proses | `execa` 10, `@lydell/node-pty` |
| UI | **Lit 3** (web components) + `vite` 8 + `shiki` (syntax highlight) |
| Lint/format | **`oxlint` + `oxfmt`** (berbasis Rust, sangat cepat) |
| Test | `vitest` 4 + `playwright` |
| Build | `tsdown`, `esbuild` |
| Supply chain | **`sigstore` 5.0.0** (signing artifact rilis) |

Arsitekturnya **plugin-first**: ada `plugin-sdk` dengan ratusan file `.d.ts` ter-ekspor, plus `schemaVersions: { state: 6, agent: 16 }` di `package.json` — artinya state dan konfigurasi agent punya **migrasi berversi**. Ini pola yang matang; framework yang menyimpan state agent tanpa versioning akan rusak saat upgrade.

### 3.2 Hermes Agent — pembanding Python (222rb bintang)

Dari `pyproject.toml` (versi `0.19.0`):

| Lapisan | Pilihan |
|---|---|
| Runtime | Python `>=3.11,<3.14` (batas atas *load-bearing*, bukan kosmetik) |
| Package manager | **`uv`** (Astral, berbasis Rust) |
| Klien LLM inti | **`openai==2.24.0`** — dipakai sebagai klien universal |
| Provider spesifik | `anthropic`, `firecrawl-py`, `exa-py`, `fal-client` → **extras, lazy-install** via `tools/lazy_deps.py` |
| Validasi | `pydantic==2.13.4` |
| HTTP | `httpx[socks]==0.28.1` |
| CLI | `fire`, `rich`, `prompt_toolkit` |
| Scheduler | `croniter==6.0.0` |
| Storage | **SQLite + FTS5** (full-text search lintas sesi) |
| Memory | integrasi **Honcho** (dialectic user modeling) |

**Dua pelajaran besar dari Hermes:**

1. **Semua dependency di-pin persis (`==X.Y.Z`), tidak ada range.** Komentar di `pyproject.toml` menjelaskan alasannya: pada 2026-05-12 worm *Mini Shai-Hulud* menyerang `mistralai 2.4.6` di PyPI. Kalau versinya ditulis `mistralai>=2.3.0,<3`, setiap instalasi di jam-jam sebelum karantina akan menarik paket terinfeksi. Ini bukan paranoia teoretis — ini insiden nyata.

2. **Aturan cakupan dependency:** *"hanya paket yang dipakai SETIAP sesi masuk `dependencies`."* Sisanya jadi extras yang di-install saat pengguna memilih backend itu. Dependency inti lebih kecil = *blast radius* lebih kecil saat serangan supply chain berikutnya.

### 3.3 Paperclip — kunci jawaban untuk "beginner sampai perusahaan"

`packages/db/package.json`:

```json
"dependencies": {
  "drizzle-orm": "^0.45.2",
  "embedded-postgres": "^18.1.0-beta.16",
  "postgres": "^3.4.9"
}
```

Ini pola yang menjawab persyaratan QuidChat secara langsung: **Postgres tertanam untuk pemula, Postgres asli untuk perusahaan, satu dialek dan satu skema untuk keduanya.** Pemula `npm install` lalu jalan — tanpa memasang server database. Perusahaan mengarahkan `DATABASE_URL` ke cluster Postgres mereka. Kode aplikasi tidak berubah sedikit pun.

Paperclip juga punya `check:migrations` yang menjalankan `check-migration-numbering.ts` dan `check-migration-safety.ts` di setiap build — migrasi divalidasi otomatis, bukan diperiksa manual.

Sisanya: pnpm monorepo (`@paperclipai/server`, `/ui`, `/db`, `/plugin-sdk`, `/shared`), `tsx`, `vitest` 4, Playwright e2e, Storybook + visual regression, dan **`promptfoo`** untuk LLM eval.

Yang paling menarik: `package.json` Paperclip punya script `smoke:openclaw-join`, `smoke:openclaw-docker-ui`, `smoke:hermes-gateway-e2e`. **Paperclip melakukan smoke test terhadap OpenClaw dan Hermes.** Artinya ekosistem 2026 sudah saling terhubung — Paperclip sebagai orkestrator, OpenClaw dan Hermes sebagai runtime, dengan MCP dan ACP sebagai protokol perantara.

---

## 4. Pola yang konvergen

Empat pola yang muncul di semua proyek besar, terlepas dari bahasa:

1. **Loop agent ditulis sendiri, bukan pakai LangChain.** Tidak satu pun dari empat proyek terbesar memakai LangChain/LlamaIndex sebagai inti. OpenClaw bahkan memasarkan diri dengan *"No Python, no chains, no graphs."* Abstraksi framework generik terbukti jadi beban, bukan bantuan, untuk runtime chat.

2. **Storage tertanam dulu, server kemudian.** OpenClaw: SQLite + `sqlite-vec`. Hermes: SQLite + FTS5. Paperclip: embedded Postgres → Postgres asli. Tidak ada yang mewajibkan pengguna memasang server database untuk mencoba.

3. **Provider-agnostic dengan adapter, bukan lock-in.** Baik lewat SDK per provider (OpenClaw) maupun satu klien universal + lazy extras (Hermes).

4. **MCP + ACP sebagai standar interop.** OpenClaw menyertakan keduanya sebagai dependency inti. Framework baru yang tidak bicara MCP akan terisolasi dari ekosistem tool yang sudah ada.

---

## 5. Rekomendasi stack QuidChat

### 5.1 Bahasa: TypeScript (Node 22+, kompatibel Bun)

**Alasan:**

- Tiga proyek paling diadopsi di kategori persis ini (chat agent runtime) semuanya TypeScript: OpenClaw 384rb, Paperclip 75rb, opencode.
- **Satu bahasa untuk semua permukaan** — runtime agent, CLI, web UI, dan browser. Ini yang bikin "universal" jadi nyata, bukan slogan. PGlite bahkan bisa jalan di browser, jadi demo QuidChat bisa hidup tanpa backend sama sekali.
- **Jalur instalasi paling ramah pemula:** `npm i -g quidchat`. Python butuh urusan venv/uv/PATH yang sering menjatuhkan pemula di langkah pertama.
- Tooling matang dan cepat: oxlint/oxfmt (Rust), vitest, tsdown.

**Trade-off yang jujur:** Python punya ekosistem ML jauh lebih dalam, dan Hermes membuktikan Python sangat viable di kategori ini (222rb bintang). Tapi framework chat **tidak melatih model** — ia memanggil API embedding dan API LLM. Kalau nanti butuh kerja ML berat (fine-tuning reranker, embedding lokal), pola yang benar adalah **sidecar Python** yang dipanggil lewat HTTP, bukan menulis ulang seluruh runtime dalam Python.

### 5.2 Penyimpanan: Postgres di semua tingkat

Ini keputusan paling penting di dokumen ini. **Satu skema, satu dialek, tiga tingkat deployment.**

| Tier | Target | Storage | Instalasi |
|---|---|---|---|
| **1 — Beginner** | Coba-coba, demo, browser | **PGlite** (`@electric-sql/pglite`) — Postgres WASM, <3MB gzip | `npm install`, nol konfigurasi |
| **2 — Enthusiast** | Dev lokal serius, self-host kecil | **`embedded-postgres`** — binary Postgres asli, dikelola proses QuidChat | Otomatis saat pertama jalan |
| **3 — Perusahaan** | Produksi, multi-tenant | Postgres apa pun (RDS / Neon / Supabase / self-host) + pgvector + AGE | `DATABASE_URL` |

Semuanya bicara protokol wire Postgres yang sama. **Satu skema Drizzle, satu set migrasi, nol cabang kode per tier.**

**Yang membuat ini bekerja:** PGlite mendukung ekstensi yang kita butuhkan (terverifikasi dari [pglite.dev/extensions](https://pglite.dev/extensions/)):

| Ekstensi | Paket | Ukuran | Fungsi di QuidChat |
|---|---|---|---|
| pgvector | `@electric-sql/pglite-pgvector` | 42,9 KB | RAG — vector similarity search |
| Apache AGE | `@electric-sql/pglite-age` | 138,2 KB | Graph — openCypher di atas Postgres |

Jadi **satu database menampung empat lapisan sekaligus**: state percakapan (tabel biasa), RAG (pgvector), graph memory (AGE), dan pencarian keyword (Postgres FTS untuk hybrid search).

**ORM: Drizzle** (`drizzle-orm` + `drizzle-kit`) — sama seperti Paperclip. TypeScript-native, migrasi berupa file SQL yang masuk repo (bisa direview di PR), tidak ada codegen ajaib. Alternatifnya Kysely (dipakai OpenClaw), tapi Drizzle menang karena migrasinya lebih rapi untuk proyek yang akan menerima kontribusi eksternal.

**Batasan PGlite yang harus jujur disampaikan:** PGlite adalah *library*, bukan server — **satu koneksi, satu proses**. Cocok untuk single-user lokal, **tidak untuk produksi multi-user**. Ini justru alasan mengapa tiering-nya perlu ada, bukan cacat desain. Dokumentasi QuidChat harus menyatakan ini eksplisit supaya tidak ada yang mendeploy Tier 1 ke produksi.

### 5.3 RAG: pgvector + Postgres FTS (hybrid)

- **Index:** HNSW. Gunakan `halfvec` kalau dimensi embedding besar (menghemat ~50% storage).
- **Hybrid search:** gabungkan pgvector (semantik) dengan Postgres full-text search (keyword) lalu rerank. Ini konsisten mengalahkan vector-only di praktik.
- **Kapan pgvector cukup:** riset pihak ketiga konsisten menyebut pgvector adalah pilihan terbaik **di bawah ~5 juta vektor** dengan kebutuhan ACID; dengan HNSW dan tuning yang benar masih sanggup sampai puluhan juta vektor dengan P95 sub-100ms.
- **Kapan tidak cukup:** filtering metadata yang kompleks dan berat. Benchmark pihak ketiga (EC2 g4dn.xlarge, 5 juta vektor 768-dim) menunjukkan Qdrant ~12ms p99 untuk filtered ANN vs pgvector ~34ms. **Angka ini dari blog, belum saya verifikasi ulang** — anggap sebagai indikasi arah, bukan fakta final.

**Konsekuensi desain:** bikin **`VectorStore` sebagai interface** dengan pgvector sebagai implementasi default, plus adapter Qdrant untuk yang butuh skala/filtering berat. Batas abstraksinya cukup tipis: `upsert`, `query`, `delete`, `createIndex`.

Satu catatan penting dari riset: *"pilihan vector database jauh lebih tidak menentukan daripada yang orang kira — strategi chunking dan pipeline retrieval jauh lebih berpengaruh."* Jangan habiskan waktu berdebat vector DB; habiskan waktu pada chunking dan reranking.

### 5.4 Graph: Apache AGE — lapisan paling berisiko

**Rekomendasi: Apache AGE di Postgres yang sama, di belakang adapter.**

Keuntungannya besar: graph dan vector di satu transaksi, satu backup, satu koneksi. Tidak ada Neo4j terpisah untuk dioperasikan pemula.

**Tapi ini bagian dengan risiko tertinggi di seluruh stack, dan saya perlu menyatakannya terang-terangan:**

- Dukungan AGE terhadap versi Postgres secara historis **tertinggal** dari rilis Postgres. Ini berarti QuidChat bisa terkunci pada versi Postgres tertentu.
- Build WASM AGE di PGlite relatif muda dibanding pgvector.
- Kalau AGE bermasalah, alternatifnya: Neo4j (paling matang, tapi JVM — latency baseline lebih tinggi dan operasional lebih berat), atau Kuzu (embedded, cepat, tapi ekosistem lebih kecil).

**Karena itu: `GraphStore` wajib jadi interface dari hari pertama.** Ini satu-satunya lapisan di mana saya menyarankan abstraksi *sebelum* ada kebutuhan kedua, justru karena kemungkinan harus ditukar cukup nyata.

**Klarifikasi yang harus diputuskan sebelum menulis kode:** "graph" punya dua arti yang sangat berbeda dan sering dicampur.

| | Graph sebagai **orkestrator** | Graph sebagai **memory** |
|---|---|---|
| Contoh | LangGraph | GraphRAG, Graphiti, Zep |
| Isinya | node = langkah eksekusi | node = entitas, edge = relasi |
| Butuh | state machine + persistence | database graph (AGE / Neo4j) |
| Rekomendasi | **Kode TypeScript biasa + state machine.** Tidak perlu graph DB. | **AGE.** Di sinilah graph DB benar-benar diperlukan. |

Untuk orkestrasi, OpenClaw dan Paperclip sama-sama tidak memakai graph DB — cukup kode dan state berversi. Menaruh eksekusi loop di dalam graph DB menambah kompleksitas tanpa imbalan.

### 5.5 Lapisan LLM: merangkul semua provider, setup nol konfigurasi

**Target:** pengguna menjalankan `quidchat`, dan QuidChat langsung menemukan sendiri model apa saja yang tersedia di mesin itu — tanpa satu pun pertanyaan konfigurasi. Yang terasa "magic" bukan sihir, tapi **auto-deteksi kredensial + registry provider yang digerakkan data.**

#### 5.5.1 Prinsip: dua adapter, bukan dua puluh

Hampir seluruh ekosistem 2026 bicara **API yang OpenAI-compatible** — termasuk 9Router, OpenRouter, Ollama, LM Studio, vLLM, llama.cpp, Groq, Together, DeepSeek, Cerebras, xAI, Fireworks. Jadi cakupan maksimum dicapai dengan **satu** adapter, bukan satu adapter per vendor.

| Adapter | Cakupan | Implementasi |
|---|---|---|
| **`openai-compatible`** | ~90% ekosistem: semua router, semua server lokal, sebagian besar cloud | Satu klien HTTP + registry `baseURL` |
| **`anthropic`** | Claude — fitur yang tidak ada padanannya di format OpenAI | `@anthropic-ai/sdk` |

Anthropic dapat adapter sendiri karena beberapa fiturnya **tidak bisa diekspresikan** lewat shim OpenAI-compatible, dan justru fitur-fitur itu yang paling menentukan biaya dan kualitas loop agent: `thinking: {type: "adaptive"}`, `output_config.effort`, prompt caching dengan `cache_control` breakpoint, dan `task_budget`. Memaksakannya lewat shim akan kehilangan semuanya.

> Provider lain yang punya fitur unik (Google `@google/genai`, Mistral) jadi **paket opsional** yang di-install saat dipilih — mengikuti aturan cakupan dependency Hermes. Dependency inti tetap kecil.

#### 5.5.2 Registry provider berbasis data, bukan kode

Jangan menulis satu file TypeScript per provider. Buat **registry deklaratif** — provider baru cukup satu entri data, tanpa menyentuh kode:

```jsonc
{
  "id": "9router",
  "label": "9Router",
  "adapter": "openai-compatible",
  "baseURL": "https://api.9router.com/v1",
  "envKeys": ["NINEROUTER_API_KEY", "NINE_ROUTER_API_KEY"],
  "modelsEndpoint": "/models",   // enumerasi model otomatis
  "isRouter": true
}
```

`opencode` memakai pendekatan serupa (registry model eksternal), dan itulah kenapa ia bisa mendukung banyak provider tanpa membengkak. Registry ini bisa **di-bundle sebagai default + di-override oleh pengguna**, sehingga provider baru tidak perlu menunggu rilis QuidChat.

#### 5.5.3 Tangga auto-deteksi kredensial

Dijalankan sekali saat startup, berhenti di kecocokan pertama per provider:

**Tingkat 1 — Environment variable.** Untuk setiap entri registry, cek `envKeys`-nya: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `NINEROUTER_API_KEY`, `GEMINI_API_KEY`, `GROQ_API_KEY`, `DEEPSEEK_API_KEY`, `MISTRAL_API_KEY`, `XAI_API_KEY`, `TOGETHER_API_KEY`, `CEREBRAS_API_KEY`, `OLLAMA_HOST`, dan seterusnya.

**Tingkat 2 — Sesi OAuth yang sudah ada.** Ini bagian yang paling terasa magic dan paling sering dilewatkan. Untuk Anthropic, urutan resolusi kredensial resmi adalah:

```
ANTHROPIC_API_KEY → ANTHROPIC_AUTH_TOKEN → profil OAuth aktif (ant auth login)
  → Workload Identity Federation → profil default di disk
```

Artinya: **pengguna yang sudah menjalankan `ant auth login` tidak perlu API key sama sekali.** Konstruktor `new Anthropic()` tanpa argumen otomatis membaca profil di `~/.config/anthropic/`. QuidChat cukup memanggil `ant auth status` untuk mendeteksi profil aktif, lalu diam dan bekerja.

Jebakan yang wajib ditangani: **`ANTHROPIC_API_KEY` yang ter-export tapi basi akan menimpa setiap profil OAuth** — bahkan `ANTHROPIC_API_KEY=""` kosong masih menang di urutan prioritasnya. Kalau QuidChat mendeteksi keduanya ada, ia harus memperingatkan pengguna, bukan gagal misterius.

**Tingkat 3 — Probe server lokal.** Cek port yang umum secara paralel dengan timeout pendek (~300ms):

| Layanan | Port | Endpoint probe |
|---|---:|---|
| Ollama | 11434 | `/api/tags` |
| LM Studio | 1234 | `/v1/models` |
| vLLM | 8000 | `/v1/models` |
| llama.cpp server | 8080 | `/v1/models` |
| Jan / lainnya | 1337 | `/v1/models` |

Yang menjawab langsung tersedia — **tanpa API key, tanpa konfigurasi, tanpa biaya.** Ini jalur terbaik untuk tier beginner: seseorang dengan Ollama terpasang bisa memakai QuidChat gratis dalam hitungan detik.

**Tingkat 4 — Impor dari konfigurasi tool lain.** Kalau pengguna sudah memakai OpenClaw, opencode, Hermes, atau Claude Code, kredensial dan preferensi model mereka sudah ada di disk. QuidChat **membaca (read-only) dan menawarkan impor**:

```
$ quidchat
✓ Ollama terdeteksi di localhost:11434 (3 model)
✓ Profil OAuth Anthropic aktif (ant auth login)
✓ OpenClaw terdeteksi — impor 2 provider? [Y/n]
✓ 9Router API key ditemukan di environment

Siap. 4 provider, 47 model. Model default: claude-opus-5
```

**Aturan keras untuk Tingkat 4:** baca saja, **jangan pernah menulis** ke konfigurasi tool lain, dan **jangan pernah menyalin secret ke konfigurasi QuidChat**. Simpan *rujukan* ke sumbernya (mis. "ambil dari env `OPENROUTER_API_KEY`"), bukan nilainya. Konfigurasi QuidChat harus aman kalau tidak sengaja ter-commit — dan `.gitignore` tetap melindunginya sebagai lapisan kedua.

#### 5.5.4 Kapabilitas ditanya, bukan ditebak

Jangan hardcode context window, harga, atau dukungan fitur — semuanya berubah tiap beberapa bulan dan hardcode akan basi secara senyap.

- **Anthropic:** panggil Models API (`client.models.retrieve(id)`) yang mengembalikan `max_input_tokens`, `max_tokens`, dan pohon `capabilities` dengan `supported: true/false` di setiap daun (thinking, effort, vision, structured outputs, dsb).
- **OpenAI-compatible:** panggil `GET /v1/models` untuk enumerasi; kapabilitas di luar itu dideteksi lewat *probe* atau di-deklarasikan di registry.

Interface `Provider` melaporkan hasilnya ke atas:

```ts
interface Provider {
  readonly id: string
  stream(req: ChatRequest): AsyncIterable<ChatEvent>
  countTokens(req: ChatRequest): Promise<number>
  capabilities(model: string): Promise<{
    contextWindow: number
    maxOutput: number
    tools: boolean
    vision: boolean
    thinking: boolean
    promptCaching: false | { minPrefixTokens: number; maxBreakpoints: number }
  }>
}
```

`minPrefixTokens` **wajib** datang dari sini, bukan konstanta: minimum prefix yang bisa di-cache **tidak monoton antar generasi model** — 512 token di Opus 5, 1024 di Opus 4.8/Sonnet 5, 4096 di Opus 4.6/Haiku 4.5. Prompt di bawah minimum **gagal di-cache tanpa error apa pun**; satu-satunya gejalanya adalah `cache_creation_input_tokens: 0`.

#### 5.5.5 Jangan bangun ulang routing — router adalah provider

9Router dan OpenRouter sudah menyelesaikan masalah routing lintas provider: auto-retry, fallback, dashboard biaya, satu API untuk ratusan model. **QuidChat tidak boleh menyainginya.** Perlakukan router sebagai provider biasa dengan flag `isRouter: true`, lalu QuidChat menambahkan lapisan yang tidak bisa dilakukan router:

| Lapisan | Pemilik |
|---|---|
| Routing lintas provider, retry, dashboard biaya | **Router** (9Router / OpenRouter) |
| Failover *lintas router* (kalau router itu sendiri mati) | **QuidChat** |
| Degradasi ke model lokal saat offline | **QuidChat** |
| Pemilihan model per-peran (chat / ringkasan / embed) | **QuidChat** |
| Prompt caching yang benar per-provider | **QuidChat** |

Failover ke model lokal saat offline adalah nilai jual nyata: QuidChat tetap hidup di pesawat atau saat API down.

#### 5.5.6 Default model

Default ke model terbaik yang tersedia, bukan yang termurah — hemat biaya adalah keputusan pengguna, bukan keputusan framework. Kalau kredensial Anthropic terdeteksi, default `claude-opus-5` (1M context, $5/$25 per MTok, 128K max output) dengan `thinking: {type: "adaptive"}` dan streaming untuk `max_tokens` besar.

Satu jebakan spesifik Opus 5 yang harus ditangani di adapter: **thinking aktif secara default**, dan `max_tokens` membatasi *thinking + teks jawaban sekaligus*. Rute yang sebelumnya tidak pernah mengaktifkan thinking dan mengetatkan `max_tokens` akan terpotong di tengah jawaban. Jangan pernah lowball `max_tokens` — default ~16K untuk non-streaming, ~64K untuk streaming.

### 5.6 Prompt caching — batasan yang harus membentuk arsitektur, bukan ditambal kemudian

Ini temuan yang paling berdampak pada desain internal QuidChat, dan paling sering diabaikan framework agentic.

Prompt cache adalah **prefix match**. Urutan render: `tools` → `system` → `messages`. **Satu byte berubah di posisi N membatalkan cache untuk semua yang setelah N.** Ekonominya: cache read ~0,1× harga input, cache write 1,25× (TTL 5 menit). Untuk loop agent yang mengirim ulang seluruh riwayat setiap iterasi, ini bukan optimasi kecil — ini perbedaan antara framework yang murah dan yang membakar uang.

Aturan yang harus ditegakkan di lapisan prompt-builder QuidChat:

| Aturan | Kenapa |
|---|---|
| **System prompt harus beku** | Menyisipkan `new Date()` atau nama user ke system prompt membatalkan seluruh cache di belakangnya, setiap request |
| **Tool set tidak boleh berubah di tengah percakapan** | `tools` dirender di posisi 0 — menambah/menghapus/mengurutkan ulang satu tool membatalkan *seluruh* cache |
| **Serialisasi harus deterministik** | `JSON.stringify` atas objek dengan urutan key tidak stabil, atau iterasi `Set`, menghasilkan byte berbeda → cache miss senyap |
| **Konteks dinamis masuk ke `messages`, bukan `system`** | Pesan di turn ke-5 tidak membatalkan apa pun sebelum turn ke-5 |
| **Maksimal 4 breakpoint per request** | Batas API |
| **Lookback hanya 20 content block** | **Ini jebakan spesifik loop agent:** satu turn dengan banyak pasangan `tool_use`/`tool_result` mudah melewati 20 block, lalu breakpoint berikutnya gagal menemukan cache sebelumnya dan miss secara senyap. Solusi: sisipkan breakpoint tiap ~15 block pada turn yang panjang. |

**Verifikasi wajib:** ekspos `usage.cache_read_input_tokens` di telemetri QuidChat. Kalau nilainya nol pada request berulang dengan prefix identik, ada *silent invalidator* — dan tanpa metrik ini tidak ada yang akan menyadarinya.

Minimum prefix yang bisa di-cache **tidak monoton antar generasi model**: 512 token di Opus 5, 1024 di Opus 4.8/Sonnet 5, 4096 di Opus 4.6/Haiku 4.5. Jadi `capabilities()` di interface Provider perlu melaporkan angka ini, bukan di-hardcode.

### 5.7 Interop: MCP + ACP sejak awal

- **MCP** (`@modelcontextprotocol/sdk`) — protokol tool. Ini yang memberi QuidChat akses ke ratusan tool yang sudah ada tanpa menulis satu integrasi pun. Non-negotiable.
- **ACP** (`@agentclientprotocol/sdk`) — protokol klien. Memungkinkan QuidChat dipakai dari editor/klien lain. OpenClaw menyertakannya; Paperclip melakukan smoke test terhadapnya. Ini arah ekosistem.

### 5.8 Dataset & evaluasi

"Dataset" untuk framework chat berarti **eval set**, bukan data training:

- **`promptfoo`** — dipakai Paperclip (`evals:smoke`). Deklaratif, jalan di CI.
- **Golden conversation set** — kumpulan percakapan berlabel di repo, jadi perubahan prompt bisa diukur, bukan dirasakan.
- **Eval RAG terpisah**: recall@k dan MRR untuk retrieval, dinilai lepas dari kualitas generasi. Kalau dicampur, regresi retrieval akan tersembunyi di balik LLM yang menutupinya.

### 5.9 Tooling & rilis

| Kebutuhan | Pilihan | Sumber |
|---|---|---|
| Monorepo | **pnpm workspaces** | OpenClaw + Paperclip |
| Test | **vitest 4** | keduanya |
| E2E | **Playwright** | keduanya |
| Lint/format | **oxlint + oxfmt** | OpenClaw — berbasis Rust, jauh lebih cepat dari ESLint |
| Build | **tsdown** | OpenClaw |
| Dev runner | **tsx** | Paperclip |
| Signing rilis | **sigstore** | OpenClaw |
| Versioning | Pertimbangkan berbasis tanggal (`2026.7.2`) | OpenClaw |

### 5.10 Keamanan supply chain — pelajaran mahal yang bisa dipinjam gratis

Dari komentar `pyproject.toml` Hermes, yang ditulis setelah insiden nyata:

1. **Pin dependency langsung ke versi persis.** Range membiarkan registry mengirim versi transitif baru tanpa review dari sisi kita.
2. **Kecilkan dependency inti.** Apa pun yang spesifik per-provider jadi optional, di-install saat dipilih.
3. **Commit lockfile** (`pnpm-lock.yaml`) dan gunakan `--frozen-lockfile` di CI.
4. **Sign artifact rilis** dengan sigstore.
5. **Aktifkan Dependabot/Renovate** dengan review manual — bukan auto-merge.

Untuk framework opensource yang akan di-`npm install` oleh ribuan orang, ini bukan opsional. QuidChat adalah rantai pasok bagi penggunanya.

---

## 6. Ringkasan rekomendasi

| Lapisan | Pilihan | Keyakinan |
|---|---|---|
| Bahasa | TypeScript, Node 22+ | **Tinggi** — 3 proyek terbesar di kategori ini semuanya TS |
| Monorepo | pnpm workspaces | **Tinggi** — OpenClaw + Paperclip |
| Database | Postgres di semua tier (PGlite → embedded-postgres → managed) | **Tinggi** — pola Paperclip, terbukti |
| ORM | Drizzle | **Tinggi** |
| RAG | pgvector + Postgres FTS, di belakang interface `VectorStore` | **Tinggi** |
| Graph | Apache AGE, **wajib** di belakang interface `GraphStore` | **Sedang** — lapisan paling berisiko |
| Loop agent | Kode sendiri, bukan LangChain | **Tinggi** — tidak ada proyek besar yang pakai |
| LLM | 2 adapter (`openai-compatible` + `anthropic`) + registry provider deklaratif | **Tinggi** |
| Setup provider | Auto-deteksi 4 tingkat: env → OAuth → probe lokal → impor konfigurasi tool lain | **Tinggi** |
| Routing | Perlakukan 9Router/OpenRouter sebagai provider; QuidChat hanya tambah failover lintas router + fallback lokal | **Tinggi** |
| Interop | MCP + ACP | **Tinggi** |
| Eval | promptfoo + golden set | **Sedang** |

---

## 7. Yang masih harus diputuskan (bukan hasil riset — butuh keputusan)

1. **Graph: orkestrator atau memory?** Kalau keduanya, harus jadi dua subsistem terpisah dengan nama berbeda. Mencampurnya adalah kesalahan desain paling umum di framework agentic.
2. **Siapa yang memegang state percakapan?** Menentukan apakah QuidChat bisa *resume*, *replay*, dan *observable*. OpenClaw memilih state berversi dengan migrasi (`schemaVersions`) — pola yang layak ditiru.
3. **Bagaimana loop berhenti?** Batas iterasi, deteksi state tidak berubah, dan *token budget*. Ini yang membedakan framework produksi dari yang membakar token tanpa batas.
4. **Bentuk plugin API.** OpenClaw meng-ekspor `plugin-sdk` besar; Paperclip punya `@paperclipai/plugin-sdk`. Permukaan API plugin adalah komitmen kompatibilitas jangka panjang — sekali dirilis, sulit diubah.
5. **Channel mana yang didukung di v1?** OpenClaw mendukung Telegram/Discord/WhatsApp lewat `grammy` dkk. Menambah channel itu mudah; mendukung semuanya sejak awal itu jebakan cakupan.

---

## 8. Sumber

Repositori (data via GitHub API, `package.json`/`pyproject.toml` via raw.githubusercontent.com):
- https://github.com/openclaw/openclaw
- https://github.com/NousResearch/hermes-agent
- https://github.com/paperclipai/paperclip
- https://github.com/666ghj/MiroFish
- https://github.com/camel-ai/oasis
- https://github.com/opencode-ai/opencode (tidak aktif) · https://opencode.ai

Dokumentasi:
- https://pglite.dev/docs/about · https://pglite.dev/extensions/
- https://github.com/pgvector/pgvector
- https://github.com/electric-sql/pglite

Perbandingan pihak ketiga (belum diverifikasi ulang — perlakukan sebagai indikasi):
- https://4xxi.com/articles/vector-database-comparison/
- https://callsphere.ai/blog/vector-database-benchmarks-2026-pgvector-qdrant-weaviate-milvus-lancedb
- https://www.firecrawl.dev/blog/best-vector-databases
- https://graphindex.io/blog/neo4j-memgraph-kuzu-benchmark
- https://blaxel.ai/blog/typescript-vs-python-ai-agents
