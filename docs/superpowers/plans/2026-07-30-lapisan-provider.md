# Rencana Lapisan Provider — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Satu paket `@quidchat/providers` yang merangkul semua provider dan router LLM dengan setup sedekat mungkin ke nol konfigurasi, plus menutup dua utang yang tercatat di spec §11.5.

**Architecture:** `packages/core` tetap library murni — tanpa jaringan, tanpa `process.env`. Paket baru `packages/providers` yang boleh keduanya. Satu adapter OpenAI-compatible menutup mayoritas layanan karena hampir semua router memakai format kabel itu; Anthropic dapat adapter native karena prompt caching-nya berbeda dan seluruh cerita biaya proyek ini bergantung padanya.

**Tech Stack:** `fetch` bawaan Node 22 — tanpa SDK, tanpa dependency runtime baru.

## Mengapa rencana ini ada

Tiga hal, dua di antaranya sudah tercatat sebagai utang:

1. **Kegagalan provider salah dilabeli.** Setiap `complete()` yang melempar dicatat sebagai `schema_invalid`. Jadi 429, 503, dan timeout masuk ke tabel `escalations` sebagai pelanggaran schema — mencemari satu-satunya sinyal yang dipakai pemilik bisnis untuk memutuskan konten apa yang perlu ditulis. Seorang pemilik yang melihat "model tidak mematuhi schema" akan menulis ulang basis pengetahuan yang sejak awal bukan masalahnya.
2. **Ronde perbaikan belum bisa menulis ulang query.** Spec §4 langkah 6 memintanya, `TenantConfig.rewriteModel` sudah ada dan **tidak dipakai sama sekali**, karena `Provider` tidak punya method penyelesaian teks biasa.
3. **Belum ada satu pun adapter.** Pipeline-nya bekerja terhadap `Provider` palsu. Tanpa adapter sungguhan, produknya belum bisa menjawab siapa pun.

## Global Constraints

- Node `>=22.22.3`. TypeScript strict; `exactOptionalPropertyTypes: true`.
- ESM only; import sumber TypeScript memakai ekstensi `.js`.
- **`packages/core` tetap tanpa dependency runtime, tanpa `process.env`, tanpa jaringan.** Paket `providers` yang memegang keduanya.
- **Tidak ada dependency runtime baru di seluruh repo.** `fetch` sudah ada di Node 22.
- **Test tidak boleh menyentuh jaringan.** Semua adapter diuji dengan `fetch` yang di-stub.
- Setiap `execute()` lewat `rowsOf()` (berlaku bila menyentuh `packages/db`).
- **Komentar kode dan commit message berbahasa INGGRIS.** Identifier juga Inggris.
  Yang tetap Indonesia HANYA copy produk: system prompt, teks penolakan,
  `high_risk_topics`, dan data fixture — itu isi yang dibaca pelanggan bisnis
  Indonesia, bukan kode.
  Kode produksi di `packages/core` dan `packages/db` sudah begitu: `rowsOf`,
  `createStore`, `getTenantConfig`, `withTenant`, `applyMigrations`. Cuplikan kode
  di rencana ini sempat memakai identifier Indonesia — itu keliru dan sudah
  diperbaiki. Kalau cuplikan dan aturan bertabrakan, **aturannya yang mengikat**.
- Commit tanpa trailer atribusi apa pun. `git add` dengan path eksplisit, **jangan** `git add -A`.
- `pnpm build` masuk verifikasi setiap task.
- Setiap perbaikan yang mengklaim memaku sebuah properti **wajib** dibuktikan dengan merusak kodenya dan menyaksikan test yang bersangkutan gagal. Tiga ronde pengerasan menemukan 14 cacat dengan cara ini dan nol dengan cara lain.

## Keputusan desain, beserta alasannya

**Satu adapter OpenAI-compatible menutup mayoritas.** OpenRouter, Groq, Together, DeepSeek, Fireworks, Ollama, vLLM, llama.cpp, dan LM Studio semuanya menerima `POST /chat/completions` dengan bentuk yang sama. Jadi "merangkul semuanya" bukan berarti menulis dua puluh adapter — ia berarti satu adapter plus daftar preset berisi base URL dan nama variabel environment.

**Anthropic dapat adapter native.** Bentuk pesannya berbeda (`system` terpisah dari `messages`), dan prompt caching-nya memakai `cache_control` pada blok konten. Menjejalkannya ke adapter OpenAI-compatible akan mematikan caching — dan test wajib #3 ada justru untuk menjaga caching itu.

**Chat dan embedding boleh dari provider BERBEDA.** Anthropic tidak punya endpoint embeddings. `TenantConfig` sudah memisahkan `chatModel` dan `embeddingModel`, jadi lapisan ini menyediakan `composite()` yang mengarahkan `complete` ke satu adapter dan `embed` ke adapter lain. Kombinasi Anthropic + embeddings OpenAI adalah setup nyata yang paling mungkin, dan tanpa ini kombinasi itu mustahil.

**Setup "magic" = deteksi dari environment.** Urutan pencarian yang deterministik atas nama variabel yang sudah dikenal, dan laporan eksplisit tentang apa yang terdeteksi. Bukan sihir yang menyembunyikan keputusan — sihir yang menghilangkan langkah, lalu memberitahu apa yang dipilihnya.

---

### Task 1: Typed error, `generateText`, dan pemetaan yang benar di pipeline

**Files:**
- Modify: `packages/core/src/provider.ts`
- Create: `packages/core/src/provider-error.ts`
- Modify: `packages/core/src/pipeline.ts`
- Modify: `packages/core/src/testing/fakes.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/core/src/pipeline.test.ts`

**Interfaces:**
- Produces: `ProviderError` (kelas), `ProviderErrorKind`, `Provider.generateText`

- [ ] **Step 1: Buat `packages/core/src/provider-error.ts`**

```ts
/**
 * Sebab kegagalan sebuah provider, dipisahkan karena AKIBATNYA berbeda.
 *
 * Ini bukan taksonomi demi kerapian. `EscalationReason` yang dicatat ke tabel
 * `escalations` adalah sinyal bisnis: pemilik bisnis membacanya untuk memutuskan konten
 * apa yang perlu ditulis. Kalau 429 dan 503 dicatat sebagai `schema_invalid`, ia akan
 * menulis ulang basis pengetahuan yang sejak awal bukan masalahnya.
 */
export type ProviderErrorKind =
  /** Model membalas sesuatu yang tidak bisa dipetakan ke `Answer`. Ini SATU-SATUNYA
   *  yang layak jadi `schema_invalid`. */
  | "schema"
  /** 429, atau kuota habis. Layanannya hidup, kita yang dibatasi. */
  | "rate_limit"
  /** 5xx, jaringan mati, timeout. Layanannya yang bermasalah. */
  | "unavailable"
  /** 401/403, kunci salah atau tidak punya akses ke model itu. Salah konfigurasi. */
  | "auth"
  /** Model yang diminta tidak dikenal provider ini. Salah konfigurasi. */
  | "unknown_model"

export class ProviderError extends Error {
  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    readonly options: { status?: number; cause?: unknown } = {},
  ) {
    super(message)
    this.name = "ProviderError"
    if (options.cause !== undefined) this.cause = options.cause
  }

  /** True bila mencoba lagi dengan permintaan yang sama masuk akal. */
  get isRetryable(): boolean {
    return this.kind === "rate_limit" || this.kind === "unavailable"
  }
}
```

- [ ] **Step 2: Tambahkan `generateText` ke `Provider`**

Di `packages/core/src/provider.ts`:

```ts
export interface Provider {
  readonly id: string
  /** Menghasilkan jawaban terstruktur. Melempar `ProviderError` — lihat `ProviderErrorKind`. */
  complete(args: { model: string; prompt: PromptParts }): Promise<CompleteResult>
  /**
   * Penyelesaian teks biasa, tanpa schema. Dipakai untuk pekerjaan internal yang
   * hasilnya bukan jawaban pelanggan — menulis ulang query pada ronde perbaikan,
   * misalnya. Sengaja TIDAK mengembalikan `Answer`: keluarannya tidak pernah tayang
   * ke pengunjung, jadi ia tidak perlu dan tidak boleh melewati validator grounding.
   */
  generateText(args: { model: string; system: string; user: string }): Promise<string>
  embed(args: { model: string; text: string }): Promise<number[]>
  capabilities(model: string): Promise<Capabilities>
}
```

- [ ] **Step 3: Petakan `ProviderError` ke `EscalationReason` di pipeline**

Di `packages/core/src/pipeline.ts`, tambahkan helper dan pakai di kedua `catch`:

```ts
/**
 * Menerjemahkan kegagalan provider ke alasan eskalasi. Bukan `schema_invalid` untuk
 * semuanya — lihat `ProviderErrorKind` untuk alasan mengapa perbedaannya penting.
 * Error yang BUKAN `ProviderError` diperlakukan sebagai tidak tersedia, bukan sebagai
 * pelanggaran schema: kita tidak tahu sebabnya, dan menuduh model lebih buruk daripada
 * mengakui ketidaktahuan.
 */
function escalationReasonFor(e: unknown): EscalationReason {
  if (e instanceof ProviderError) {
    switch (e.kind) {
      case "schema":
        return "schema_invalid"
      case "rate_limit":
      case "unavailable":
      case "auth":
      case "unknown_model":
        return "provider_unavailable"
    }
  }
  return "provider_unavailable"
}
```

lalu:

```ts
  try {
    embedding = await provider.embed({ model: config.embeddingModel, text: question })
  } catch (e) {
    return refuse(escalationReasonFor(e))
  }
```

dan di dalam loop:

```ts
    try {
      result = await provider.complete({ model: config.chatModel, prompt })
    } catch (e) {
      return refuse(escalationReasonFor(e))
    }
```

- [ ] **Step 4: Sesuaikan `FakeProvider` dan ekspor dari index**

`FakeProvider` mendapat `generateText` yang mencatat panggilannya:

```ts
  textCalls: { system: string; user: string }[] = []
  /** Balasan yang dikembalikan `generateText`, bisa disetel test. */
  textReply = "pertanyaan yang ditulis ulang"

  async generateText(args: { model: string; system: string; user: string }): Promise<string> {
    this.textCalls.push({ system: args.system, user: args.user })
    return this.textReply
  }
```

Tambahkan `export * from "./provider-error.js"` ke `packages/core/src/index.ts`.

- [ ] **Step 5: Test bahwa pemetaannya benar**

Di `packages/core/src/pipeline.test.ts`, ganti test `schema_invalid` yang ada dengan satu test bertabel:

```ts
  it("memetakan setiap sebab kegagalan provider ke alasan eskalasi yang benar", async () => {
    // Test lama hanya membuktikan bahwa provider yang melempar menghasilkan
    // `schema_invalid`. Itu justru cacatnya: 429 dan 503 pun dicatat begitu, dan
    // pemilik bisnis yang membaca "model tidak mematuhi schema" akan menulis ulang
    // basis pengetahuan yang bukan masalahnya.
    const kasus: [ProviderErrorKind | "bukan-ProviderError", EscalationReason][] = [
      ["schema", "schema_invalid"],
      ["rate_limit", "provider_unavailable"],
      ["unavailable", "provider_unavailable"],
      ["auth", "provider_unavailable"],
      ["unknown_model", "provider_unavailable"],
      ["bukan-ProviderError", "provider_unavailable"],
    ]

    for (const [sebab, diharapkan] of kasus) {
      const store = new MemoryStore([candidate])
      const provider: Provider = {
        id: "rusak",
        complete: async () => {
          throw sebab === "bukan-ProviderError"
            ? new Error("sesuatu yang tidak kami kenali")
            : new ProviderError(sebab, `gagal: ${sebab}`)
        },
        generateText: async () => "",
        embed: async () => Array.from({ length: 1536 }, () => 0),
        capabilities: async () => ({
          contextWindow: 1, maxOutput: 1, tools: false, vision: false,
          thinking: false, promptCaching: false as const,
        }),
      }
      const res = await answer({ store, provider, ...ctx })
      expect(res.kind).toBe("refused")
      if (res.kind === "refused") expect(res.reason).toBe(diharapkan)
    }
  })
```

- [ ] **Step 6: Verifikasi**

```bash
pnpm test && pnpm typecheck && pnpm lint && pnpm build
```

Lalu buktikan test barunya bisa gagal: ubah `escalationReasonFor` agar selalu mengembalikan `"schema_invalid"` dan pastikan test itu **gagal** pada kasus `rate_limit`. Pulihkan.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src
git commit -m "feat(core): give provider failures a cause so escalations stay meaningful"
```

---

### Task 2: Adapter OpenAI-compatible

**Files:**
- Create: `packages/providers/package.json`, `packages/providers/tsconfig.json`
- Create: `packages/providers/src/index.ts`
- Create: `packages/providers/src/openai-compatible.ts`
- Create: `packages/providers/src/openai-compatible.test.ts`

**Interfaces:**
- Produces: `openAiCompatible(opts: { id: string; baseUrl: string; apiKey: string; fetchImpl?: typeof fetch }): Provider`

Satu adapter ini menutup OpenAI, OpenRouter, Groq, Together, DeepSeek, Fireworks, Ollama, vLLM, llama.cpp, dan LM Studio, karena semuanya menerima `POST {baseUrl}/chat/completions` dengan bentuk yang sama.

- [ ] **Step 1: Scaffold paket**

`packages/providers/package.json` — hanya mendeklarasikan apa yang task ini buat:

```json
{
  "name": "@quidchat/providers",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=22.22.3" },
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "build": "tsdown src/index.ts --dts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": { "@quidchat/core": "workspace:*" }
}
```

`packages/providers/tsconfig.json` menyalin bentuk yang dipakai `packages/db`.

- [ ] **Step 2: Tulis test dulu, dengan `fetch` yang di-stub**

Buat `packages/providers/src/openai-compatible.test.ts`. `fetchPalsu` mencatat permintaan dan mengembalikan balasan yang disiapkan, jadi test tidak pernah menyentuh jaringan:

```ts
import { ProviderError } from "@quidchat/core"
import { describe, expect, it } from "vitest"
import { openAiCompatible } from "./openai-compatible.js"

type Rekaman = { url: string; body: Record<string, unknown>; headers: Record<string, string> }

function fetchPalsu(balasan: { status?: number; json?: unknown; body?: string }) {
  const rekaman: Rekaman[] = []
  const impl = (async (url: string | URL, init?: RequestInit) => {
    rekaman.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      headers: (init?.headers ?? {}) as Record<string, string>,
    })
    const status = balasan.status ?? 200
    const teks = balasan.body ?? JSON.stringify(balasan.json ?? {})
    return new Response(teks, { status, headers: { "content-type": "application/json" } })
  }) as unknown as typeof fetch
  return { impl, rekaman }
}

const prompt = {
  system: "kamu asisten",
  history: [{ role: "user" as const, content: "halo" }],
  currentTurn: "<konteks>[k1] isi</konteks>\nPertanyaan pelanggan: garansi?",
}

const jawabanValid = {
  choices: [{
    message: {
      content: JSON.stringify({
        segments: [{ text: "Garansi 12 bulan.", kind: "business_claim", citations: ["k1"] }],
      }),
    },
  }],
  usage: { prompt_tokens: 100, completion_tokens: 20 },
}

describe("openAiCompatible", () => {
  it("mengirim system, history, dan turn sekarang dalam urutan itu", async () => {
    const { impl, rekaman } = fetchPalsu({ json: jawabanValid })
    const p = openAiCompatible({ id: "uji", baseUrl: "https://contoh.id/v1", apiKey: "k", fetchImpl: impl })
    await p.complete({ model: "m", prompt })

    expect(rekaman[0]!.url).toBe("https://contoh.id/v1/chat/completions")
    const messages = rekaman[0]!.body.messages as { role: string; content: string }[]
    // Urutannya BUKAN selera: cache LLM berbasis prefix, jadi yang stabil wajib di depan
    // dan yang volatil di belakang. Membalik ini membatalkan cache setiap pesan tanpa
    // error apa pun — persis regresi yang test wajib #3 di packages/core menjaga.
    expect(messages.map((m) => m.role)).toEqual(["system", "user", "user"])
    expect(messages[0]!.content).toBe("kamu asisten")
    expect(messages[1]!.content).toBe("halo")
    expect(messages[2]!.content).toContain("Pertanyaan pelanggan: garansi?")
  })

  it("mengurai jawaban terstruktur dan melaporkan pemakaian token", async () => {
    const { impl } = fetchPalsu({ json: jawabanValid })
    const p = openAiCompatible({ id: "uji", baseUrl: "https://contoh.id/v1", apiKey: "k", fetchImpl: impl })
    const hasil = await p.complete({ model: "m", prompt })
    expect(hasil.answer.segments).toHaveLength(1)
    expect(hasil.usage.inputTokens).toBe(100)
    expect(hasil.usage.outputTokens).toBe(20)
  })

  it("membawa kunci di header Authorization", async () => {
    const { impl, rekaman } = fetchPalsu({ json: jawabanValid })
    const p = openAiCompatible({ id: "uji", baseUrl: "https://contoh.id/v1", apiKey: "rahasia", fetchImpl: impl })
    await p.complete({ model: "m", prompt })
    expect(rekaman[0]!.headers.Authorization).toBe("Bearer rahasia")
  })

  it("memetakan status HTTP ke sebab ProviderError yang benar", async () => {
    const kasus: [number, string][] = [
      [401, "auth"], [403, "auth"], [404, "unknown_model"],
      [429, "rate_limit"], [500, "unavailable"], [503, "unavailable"],
    ]
    for (const [status, sebab] of kasus) {
      const { impl } = fetchPalsu({ status, json: { error: { message: "x" } } })
      const p = openAiCompatible({ id: "uji", baseUrl: "https://contoh.id/v1", apiKey: "k", fetchImpl: impl })
      await expect(p.complete({ model: "m", prompt })).rejects.toThrow(ProviderError)
      await p.complete({ model: "m", prompt }).catch((e: unknown) => {
        expect((e as ProviderError).kind).toBe(sebab)
      })
    }
  })

  it("balasan yang bukan JSON menjadi sebab `schema`, bukan `unavailable`", async () => {
    // Bedanya penting: `schema` mencatat `schema_invalid` di escalations dan itu MEMANG
    // sinyal bahwa model gagal mematuhi format. `unavailable` mencatat hal lain.
    const { impl } = fetchPalsu({ json: { choices: [{ message: { content: "maaf, bukan JSON" } }] } })
    const p = openAiCompatible({ id: "uji", baseUrl: "https://contoh.id/v1", apiKey: "k", fetchImpl: impl })
    await p.complete({ model: "m", prompt }).catch((e: unknown) => {
      expect((e as ProviderError).kind).toBe("schema")
    })
  })

  it("menolak JSON yang bentuknya bukan Answer", async () => {
    const { impl } = fetchPalsu({
      json: { choices: [{ message: { content: JSON.stringify({ bukan: "segments" }) } }] },
    })
    const p = openAiCompatible({ id: "uji", baseUrl: "https://contoh.id/v1", apiKey: "k", fetchImpl: impl })
    await p.complete({ model: "m", prompt }).catch((e: unknown) => {
      expect((e as ProviderError).kind).toBe("schema")
    })
  })

  it("embed mengembalikan vektor dari endpoint embeddings", async () => {
    const { impl, rekaman } = fetchPalsu({ json: { data: [{ embedding: [0.1, 0.2, 0.3] }] } })
    const p = openAiCompatible({ id: "uji", baseUrl: "https://contoh.id/v1", apiKey: "k", fetchImpl: impl })
    const v = await p.embed({ model: "e", text: "halo" })
    expect(v).toEqual([0.1, 0.2, 0.3])
    expect(rekaman[0]!.url).toBe("https://contoh.id/v1/embeddings")
  })

  it("generateText mengembalikan teks apa adanya, tanpa mengurai JSON", async () => {
    const { impl } = fetchPalsu({ json: { choices: [{ message: { content: "garansi berapa bulan" } }] } })
    const p = openAiCompatible({ id: "uji", baseUrl: "https://contoh.id/v1", apiKey: "k", fetchImpl: impl })
    const t = await p.generateText({ model: "m", system: "tulis ulang", user: "garansi?" })
    expect(t).toBe("garansi berapa bulan")
  })

  it("baseUrl bergaris miring di ujung tidak menghasilkan URL berganda", async () => {
    const { impl, rekaman } = fetchPalsu({ json: jawabanValid })
    const p = openAiCompatible({ id: "uji", baseUrl: "https://contoh.id/v1/", apiKey: "k", fetchImpl: impl })
    await p.complete({ model: "m", prompt })
    expect(rekaman[0]!.url).toBe("https://contoh.id/v1/chat/completions")
  })
})
```

- [ ] **Step 3: Jalankan test untuk memastikan gagal**

Run: `pnpm vitest run packages/providers/src/openai-compatible.test.ts`
Expected: FAIL — modulnya belum ada.

- [ ] **Step 4: Implementasi**

Buat `packages/providers/src/openai-compatible.ts`. Poin yang tidak boleh berubah: urutan `system → history → currentTurn`, dan pemetaan status ke sebab.

```ts
import { ProviderError, type Answer, type Capabilities, type CompleteResult, type Provider, type PromptParts } from "@quidchat/core"

/** Memetakan status HTTP ke sebab kegagalan. Bukan semuanya `unavailable`. */
function reasonFromStatus(status: number): "auth" | "unknown_model" | "rate_limit" | "unavailable" {
  if (status === 401 || status === 403) return "auth"
  if (status === 404) return "unknown_model"
  if (status === 429) return "rate_limit"
  return "unavailable"
}

/** Membuang garis miring di ujung supaya `baseUrl` dengan atau tanpa itu sama saja. */
const trimTrailingSlash = (u: string) => u.replace(/\/+$/, "")

/** Memeriksa bentuk `Answer` sebelum ia dipercaya. Model bisa membalas JSON yang sah
 *  tapi bukan bentuk yang kita minta. */
export function asAnswer(nilai: unknown): Answer {
  const o = nilai as { segments?: unknown }
  if (!Array.isArray(o.segments)) {
    throw new ProviderError("schema", "balasan tidak punya array `segments`")
  }
  for (const s of o.segments as { kind?: unknown; text?: unknown; citations?: unknown }[]) {
    if (typeof s.text !== "string") {
      throw new ProviderError("schema", "sebuah segmen tidak punya `text` bertipe string")
    }
    if (s.kind !== "general" && s.kind !== "business_claim") {
      throw new ProviderError("schema", `kind segmen tidak dikenal: ${String(s.kind)}`)
    }
    if (s.kind === "business_claim" && !Array.isArray(s.citations)) {
      throw new ProviderError("schema", "business_claim tanpa array `citations`")
    }
  }
  return nilai as Answer
}

/**
 * Adapter untuk layanan apa pun yang menerima format kabel OpenAI di
 * `POST {baseUrl}/chat/completions`. Itu mencakup OpenAI sendiri, OpenRouter, Groq,
 * Together, DeepSeek, Fireworks, dan runner lokal seperti Ollama, vLLM, llama.cpp,
 * dan LM Studio.
 *
 * `fetchImpl` bisa disuntik supaya test tidak pernah menyentuh jaringan.
 */
export function openAiCompatible(opts: {
  id: string
  baseUrl: string
  apiKey: string
  fetchImpl?: typeof fetch
}): Provider {
  const base = trimTrailingSlash(opts.baseUrl)
  const f = opts.fetchImpl ?? fetch

  async function call(jalur: string, body: unknown): Promise<Record<string, unknown>> {
    let res: Response
    try {
      res = await f(`${base}${jalur}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${opts.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
      })
    } catch (cause) {
      // Jaringan mati, DNS gagal, timeout. Bukan salah model.
      throw new ProviderError("unavailable", `tidak bisa menghubungi ${opts.id}`, { cause })
    }
    if (!res.ok) {
      throw new ProviderError(
        reasonFromStatus(res.status),
        `${opts.id} membalas ${res.status}`,
        { status: res.status },
      )
    }
    return (await res.json()) as Record<string, unknown>
  }

  /** Menyusun messages dengan urutan STABIL -> VOLATIL. Cache LLM berbasis prefix,
   *  jadi urutan ini yang menentukan apakah caching bekerja sama sekali. */
  function messagesFrom(prompt: PromptParts) {
    return [
      { role: "system", content: prompt.system },
      ...prompt.history.map((h) => ({ role: h.role, content: h.content })),
      { role: "user", content: prompt.currentTurn },
    ]
  }

  return {
    id: opts.id,

    async complete({ model, prompt }): Promise<CompleteResult> {
      const j = await call("/chat/completions", {
        model,
        messages: messagesFrom(prompt),
        response_format: { type: "json_object" },
      })
      const pilihan = (j.choices as { message?: { content?: unknown } }[] | undefined)?.[0]
      const teks = pilihan?.message?.content
      if (typeof teks !== "string") {
        throw new ProviderError("schema", "balasan tanpa teks di choices[0].message.content")
      }
      let diurai: unknown
      try {
        diurai = JSON.parse(teks)
      } catch (cause) {
        throw new ProviderError("schema", "balasan model bukan JSON yang sah", { cause })
      }
      const pakai = (j.usage ?? {}) as Record<string, number | undefined>
      return {
        answer: asAnswer(parsed),
        usage: {
          inputTokens: pakai.prompt_tokens ?? 0,
          outputTokens: pakai.completion_tokens ?? 0,
          // Format OpenAI melaporkan token cache di tempat yang berbeda-beda antar
          // layanan; `null` berarti "tidak diketahui", bukan "nol".
          cachedTokens: pakai.prompt_cache_hit_tokens ?? null,
        },
      }
    },

    async generateText({ model, system, user }): Promise<string> {
      const j = await call("/chat/completions", {
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      })
      const pilihan = (j.choices as { message?: { content?: unknown } }[] | undefined)?.[0]
      const teks = pilihan?.message?.content
      if (typeof teks !== "string") {
        throw new ProviderError("schema", "balasan tanpa teks")
      }
      return teks
    },

    async embed({ model, text }): Promise<number[]> {
      const j = await call("/embeddings", { model, input: text })
      const data = (j.data as { embedding?: unknown }[] | undefined)?.[0]
      if (!Array.isArray(data?.embedding)) {
        throw new ProviderError("schema", "balasan embeddings tanpa array `embedding`")
      }
      return data.embedding as number[]
    },

    async capabilities(): Promise<Capabilities> {
      // Konservatif dengan sengaja. Task berikutnya menambahkan registri kemampuan;
      // sampai itu ada, angka yang terlalu optimistis lebih berbahaya daripada yang
      // terlalu kecil — yang pertama menyebabkan permintaan ditolak di tengah jalan.
      return {
        contextWindow: 128_000,
        maxOutput: 4_096,
        tools: false,
        vision: false,
        thinking: false,
        promptCaching: false,
      }
    },
  }
}
```

Dan `packages/providers/src/index.ts`:

```ts
export * from "./openai-compatible.js"
```

- [ ] **Step 5: Verifikasi**

```bash
pnpm install
pnpm test && pnpm typecheck && pnpm lint && pnpm build
```

Lalu buktikan test urutan pesan bisa gagal: tukar urutan `history` dan `currentTurn` di `messagesFrom`, pastikan test pertama **gagal**, pulihkan. Laporkan.

Dan pastikan **tidak ada** panggilan jaringan sungguhan: `grep -rn "fetch(" packages/providers/src/*.test.ts` harus nol hasil selain stub-nya sendiri.

- [ ] **Step 6: Commit**

```bash
git add packages/providers pnpm-lock.yaml
git commit -m "feat(providers): add one adapter for every OpenAI-compatible service"
```

---

### Task 3: Adapter Anthropic dengan prompt caching

**Files:**
- Create: `packages/providers/src/anthropic.ts`
- Create: `packages/providers/src/anthropic.test.ts`
- Modify: `packages/providers/src/index.ts`

Anthropic dapat adapter sendiri karena dua hal yang tidak bisa dipetakan ke format OpenAI: `system` terpisah dari `messages`, dan prompt caching memakai `cache_control` pada blok konten. Seluruh cerita biaya proyek ini bergantung pada caching itu.

- [ ] **Step 1: Test dulu**

Buat `packages/providers/src/anthropic.test.ts` dengan `fetchPalsu` yang sama bentuknya. Yang wajib diuji:

- URL-nya `{baseUrl}/messages`, dan headernya memakai `x-api-key` plus `anthropic-version`, **bukan** `Authorization: Bearer`.
- `system` dikirim sebagai array blok dengan `cache_control: { type: "ephemeral" }` pada blok terakhir — inilah titik cache-nya, dan tanpa test ini caching bisa hilang tanpa gejala selain tagihan.
- `messages` memuat history lalu `currentTurn`, dan **tidak** memuat `system`.
- `usage.cache_read_input_tokens` dipetakan ke `usage.cachedTokens`.
- Status HTTP dipetakan ke sebab yang sama seperti adapter OpenAI-compatible.
- `embed` melempar `ProviderError` bersebab `unknown_model` dengan pesan yang menyebut bahwa Anthropic tidak punya endpoint embeddings dan menyarankan `composite()`. Ini bukan kegagalan yang perlu disembunyikan — ia harus mengarahkan orang ke solusinya.

- [ ] **Step 2: Implementasi**

Bentuk permintaannya:

```ts
      const j = await call("/messages", {
        model,
        max_tokens: 4096,
        // `system` sebagai ARRAY blok, dengan cache_control di blok terakhir. Ini titik
        // cache-nya. Prompt caching berbasis prefix, dan `PromptParts` sudah disusun
        // stabil -> volatil justru supaya titik ini bisa diletakkan di sini.
        system: [
          { type: "text", text: prompt.system, cache_control: { type: "ephemeral" } },
        ],
        messages: [
          ...prompt.history.map((h) => ({ role: h.role, content: h.content })),
          { role: "user", content: prompt.currentTurn },
        ],
      })
```

Header:

```ts
        headers: {
          "x-api-key": opts.apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
```

Balasannya diambil dari `content[0].text`, lalu diurai dan divalidasi dengan `asAnswer` yang sama — **ekspor helper itu dari `openai-compatible.ts`** alih-alih menyalinnya, supaya validasi bentuk `Answer` hanya punya satu definisi.

`usage` dipetakan dari `input_tokens`, `output_tokens`, dan `cache_read_input_tokens`.

`capabilities` mengembalikan `promptCaching: { minPrefixTokens: 1024, maxBreakpoints: 4 }` — ini adapter yang benar-benar mendukungnya.

- [ ] **Step 3: Verifikasi, lalu buktikan test cache bisa gagal**

Hapus `cache_control` dari blok system, pastikan test yang bersangkutan **gagal**, pulihkan. Itu satu-satunya cara memastikan caching benar-benar terpasang: kalau ia hilang, tidak ada error dan tidak ada log — hanya tagihan.

```bash
pnpm test && pnpm typecheck && pnpm lint && pnpm build
```

- [ ] **Step 4: Commit**

```bash
git add packages/providers/src
git commit -m "feat(providers): add the Anthropic adapter with its cache breakpoint"
```

---

### Task 4: Setup tanpa konfigurasi — preset, deteksi environment, dan komposit

**Files:**
- Create: `packages/providers/src/presets.ts`
- Create: `packages/providers/src/resolve.ts`
- Create: `packages/providers/src/composite.ts`
- Create: `packages/providers/src/resolve.test.ts`
- Create: `packages/providers/src/composite.test.ts`
- Modify: `packages/providers/src/index.ts`

Inilah bagian "magic" yang Anda minta. Bentuknya bukan sihir yang menyembunyikan keputusan, tapi sihir yang **menghilangkan langkah lalu memberi tahu apa yang dipilihnya**.

- [ ] **Step 1: Daftar preset**

`packages/providers/src/presets.ts` memetakan nama layanan ke base URL dan nama variabel environment. Minimal: `openai`, `anthropic`, `openrouter`, `groq`, `together`, `deepseek`, `fireworks`, `ollama`, `vllm`, `lmstudio`, `llamacpp`.

Preset lokal (`ollama`, `vllm`, `lmstudio`, `llamacpp`) tidak butuh kunci — sediakan `apiKeyOpsional: true` dan pakai string kosong bila variabelnya tidak ada. Base URL default mereka `http://localhost:11434/v1`, `http://localhost:8000/v1`, `http://localhost:1234/v1`, `http://localhost:8080/v1`.

Setiap preset juga menyebut `kind: "openai-compatible" | "anthropic"` supaya resolver tahu adapter mana yang dipakai.

- [ ] **Step 2: Resolver dengan laporan**

`resolveProviders(env: Record<string, string | undefined>): HasilResolve` mengembalikan:

```ts
export type HasilResolve = {
  /** Provider siap pakai, atau null bila tidak ada satu pun yang bisa dibentuk. */
  provider: Provider | null
  /** Apa yang dipilih untuk chat dan untuk embedding, supaya bisa ditampilkan. */
  dipilih: { chat: string | null; embed: string | null }
  /** Setiap preset yang diperiksa beserta hasilnya. Ini yang membuat "magic"-nya
   *  bisa dipertanggungjawabkan: pengguna bisa melihat MENGAPA sesuatu terpilih. */
  jejak: { preset: string; variabel: string; ada: boolean }[]
}
```

Aturannya deterministik dan **wajib diuji**: urutan pencarian tetap, preset pertama yang variabelnya ada menang untuk chat. Untuk embedding, preset pertama yang **punya endpoint embeddings** menang — jadi kalau hanya Anthropic yang tersedia, `dipilih.embed` bernilai `null` dan `provider` bernilai `null`, dengan jejak yang menjelaskannya. Menyerahkan provider yang tidak bisa meng-embed akan gagal di permintaan pertama, jauh dari sebabnya.

Resolver **tidak** membaca `process.env` sendiri — ia menerima `env` sebagai argumen. Itu yang membuatnya bisa diuji tanpa menyentuh environment sungguhan, dan yang menjaga batas bahwa hanya lapisan terluar yang menyentuh proses.

- [ ] **Step 3: Komposit**

`composite({ chat, embed }: { chat: Provider; embed: Provider }): Provider` mengarahkan `complete` dan `generateText` ke `chat`, `embed` ke `embed`, dan `capabilities` ke `chat`. `id`-nya menggabungkan keduanya, misalnya `"anthropic+openai"`, supaya log dan pesan error menyebut keduanya.

Ini yang membuat kombinasi paling mungkin di dunia nyata jadi mungkin: chat dari Anthropic, embedding dari OpenAI.

- [ ] **Step 4: Test**

Yang wajib:
- Env kosong → `provider` null, `jejak` memuat setiap preset dengan `ada: false`.
- Hanya `OPENAI_API_KEY` → chat dan embed keduanya `openai`, satu provider tunggal.
- Hanya `ANTHROPIC_API_KEY` → `provider` **null**, `dipilih.embed` null, dan jejaknya menjelaskan. Ini test yang paling penting di task ini: ia mencegah lapisan ini menyerahkan provider yang pasti gagal nanti.
- `ANTHROPIC_API_KEY` **dan** `OPENAI_API_KEY` → komposit, `id` menyebut keduanya, chat ke Anthropic.
- Urutan preset dipatuhi ketika beberapa kunci ada sekaligus.
- Preset lokal terdeteksi tanpa kunci apa pun bila base URL-nya diset lewat variabel.
- `composite` benar mengarahkan: `complete` hanya menyentuh adapter chat, `embed` hanya menyentuh adapter embed — dibuktikan dengan dua provider palsu yang mencatat panggilan.

- [ ] **Step 5: Verifikasi**

```bash
pnpm test && pnpm typecheck && pnpm lint && pnpm build
```

Lalu buktikan test Anthropic-sendirian bisa gagal: buat resolver mengembalikan adapter Anthropic sebagai provider tunggal, pastikan test itu **gagal**, pulihkan.

- [ ] **Step 6: Commit**

```bash
git add packages/providers/src
git commit -m "feat(providers): resolve a provider from the environment, and say what it chose"
```

---

### Task 5: Test kontrak provider, dan ronde perbaikan yang menulis ulang query

**Files:**
- Create: `packages/providers/src/kontrak.test.ts`
- Modify: `packages/core/src/pipeline.ts`
- Modify: `packages/core/src/pipeline.test.ts`

- [ ] **Step 1: Test kontrak yang berlaku untuk SETIAP adapter**

Spec §11 meminta ini: *"Kontrak provider — setiap adapter memenuhi interface yang sama."* Satu berkas test yang menjalankan tabel kasus yang sama terhadap setiap adapter, sehingga adapter berikutnya tidak bisa mendarat dengan perilaku yang menyimpang.

Yang diperiksa untuk setiap adapter, dengan `fetch` di-stub:

- `id` tidak kosong.
- `complete` mengembalikan `Answer` yang valid pada balasan yang benar.
- `complete` melempar `ProviderError` bersebab `schema` pada balasan yang bukan JSON.
- Status 429 → `rate_limit`; 401 → `auth`; 500 → `unavailable`; 404 → `unknown_model`.
- `generateText` mengembalikan string tanpa mengurai JSON.
- `capabilities` mengembalikan angka `contextWindow` dan `maxOutput` yang positif.
- Kegagalan jaringan (fetch yang melempar) → `unavailable`, **bukan** `schema`.

Tulis sebagai `describe.each` atas daftar adapter, supaya menambah adapter berarti menambah satu baris.

- [ ] **Step 2: Ronde perbaikan menulis ulang query**

Ini menutup utang §11.5 yang kedua. Sekarang ronde kedua hanya membawa umpan balik verdict. Spec §4 langkah 6 meminta query ditulis ulang lalu retrieval diulang, dan `TenantConfig.rewriteModel` ada untuk itu.

Di `packages/core/src/pipeline.ts`, di dalam loop, setelah verdict gagal dan **hanya bila masih ada ronde berikutnya**:

```ts
    // Ronde perbaikan: tulis ulang pertanyaannya lalu retrieve ULANG, bukan hanya
    // mengirim prompt yang sama dengan catatan. Spec §4 langkah 6 memintanya, dan
    // `rewriteModel` ada justru untuk ini.
    //
    // Kalau penulisan ulang gagal, itu BUKAN alasan menolak: kita masih punya kandidat
    // dari ronde pertama dan umpan balik verdict. Jadi kegagalannya ditelan dan ronde
    // berikutnya jalan dengan bahan yang ada.
    if (round < MAX_ROUNDS) {
      feedback = `${verdict.violation} — ${verdict.detail}`
      try {
        const ditulisUlang = await provider.generateText({
          model: config.rewriteModel,
          system:
            "Tulis ulang pertanyaan pelanggan menjadi satu kueri pencarian yang lebih " +
            "spesifik. Jawab HANYA dengan kuerinya, tanpa penjelasan.",
          user: question,
        })
        const bersih = ditulisUlang.trim()
        if (bersih.length > 0) {
          const embeddingBaru = await provider.embed({
            model: config.embeddingModel,
            text: bersih,
          })
          const kandidatBaru = await store.searchChunks({
            tenantId, query: bersih, embedding: embeddingBaru,
            embeddingModel: config.embeddingModel, limit: CANDIDATE_LIMIT,
          })
          // Hanya dipakai kalau menghasilkan sesuatu. Retrieval yang kosong lebih buruk
          // daripada kandidat ronde pertama yang tidak sempurna.
          if (kandidatBaru.length > 0) candidates = kandidatBaru
        }
      } catch {
        // Sengaja ditelan — lihat komentar di atas.
      }
    }
```

`candidates` perlu jadi `let`, dan `feedback` tetap dibawa seperti sebelumnya.

- [ ] **Step 3: Test bahwa penulisan ulang benar terjadi dan benar dipakai**

Yang wajib:
- Ronde kedua memakai `rewriteModel` untuk `generateText`, bukan `chatModel` — dibuktikan dari `provider.textCalls` dan model yang dicatat.
- Ketika penulisan ulang menghasilkan kandidat baru, prompt ronde kedua memuat kandidat itu.
- Ketika `generateText` melempar, pipeline **tetap** mencoba ronde kedua dan tidak menolak karenanya.
- Ketika retrieval ulang kosong, kandidat ronde pertama tetap dipakai.
- `prefixOf` ronde pertama dan kedua tetap sama — penulisan ulang tidak boleh menyentuh `system`.

- [ ] **Step 4: Verifikasi**

```bash
pnpm test && pnpm typecheck && pnpm lint && pnpm build
```

Lalu buktikan: ubah `config.rewriteModel` menjadi `config.chatModel` di panggilan `generateText`, pastikan test yang bersangkutan **gagal**, pulihkan.

- [ ] **Step 5: Commit**

```bash
git add packages/providers/src packages/core/src
git commit -m "feat(core): rewrite the query on the repair round, and pin the provider contract"
```

---

## Definition of Done

- Kegagalan provider punya sebab bertipe, dan hanya sebab `schema` yang menjadi `schema_invalid` di tabel `escalations`.
- Satu adapter menutup setiap layanan berformat OpenAI; Anthropic punya adapter native dengan titik cache yang diuji.
- Chat dan embedding boleh berasal dari provider berbeda, dan kombinasi Anthropic + embeddings OpenAI bekerja.
- Resolver membentuk provider dari environment, menolak menyerahkan provider yang tidak bisa meng-embed, dan **melaporkan** apa yang dipilihnya beserta alasannya.
- Setiap adapter lulus test kontrak yang sama.
- Ronde perbaikan menulis ulang query dan me-retrieve ulang, memakai `rewriteModel` yang sebelumnya tidak terpakai.
- Nol dependency runtime baru; nol panggilan jaringan di test.
- `pnpm test`, `pnpm typecheck`, `pnpm lint` (0 peringatan), `pnpm build` semuanya hijau.
