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

/** Menyusun daftar messages dengan urutan STABIL -> VOLATIL. Cache LLM berbasis
 *  prefix, jadi urutan inilah yang menentukan apakah caching bekerja sama sekali.
 *  Membalik urutan ini membatalkan cache pada setiap pesan tanpa error dan tanpa
 *  log apa pun. */
function messagesFrom(prompt: PromptParts) {
  return [
    { role: "system", content: prompt.system },
    ...prompt.history.map((h) => ({ role: h.role, content: h.content })),
    { role: "user", content: prompt.currentTurn },
  ]
}

/** Memeriksa bentuk `Answer` sebelum ia dipercaya. Model bisa membalas JSON yang
 *  sah tapi tetap bukan bentuk yang kita minta. */
export function asAnswer(value: unknown): Answer {
  const o = value as { segments?: unknown }
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
  return value as Answer
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

  async function call(path: string, body: unknown): Promise<Record<string, unknown>> {
    let res: Response
    try {
      res = await f(`${base}${path}`, {
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

  return {
    id: opts.id,

    async complete({ model, prompt }): Promise<CompleteResult> {
      const j = await call("/chat/completions", {
        model,
        messages: messagesFrom(prompt),
        response_format: { type: "json_object" },
      })
      const choice = (j.choices as { message?: { content?: unknown } }[] | undefined)?.[0]
      const text = choice?.message?.content
      if (typeof text !== "string") {
        throw new ProviderError("schema", "balasan tanpa teks di choices[0].message.content")
      }
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch (cause) {
        throw new ProviderError("schema", "balasan model bukan JSON yang sah", { cause })
      }
      const usage = (j.usage ?? {}) as Record<string, number | undefined>
      return {
        answer: asAnswer(parsed),
        usage: {
          inputTokens: usage.prompt_tokens ?? 0,
          outputTokens: usage.completion_tokens ?? 0,
          // Field yang melaporkan token cache berbeda-beda letaknya antar layanan
          // OpenAI-compatible; `null` berarti "tidak diketahui", bukan "nol".
          cachedTokens: usage.prompt_cache_hit_tokens ?? null,
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
      const choice = (j.choices as { message?: { content?: unknown } }[] | undefined)?.[0]
      const text = choice?.message?.content
      if (typeof text !== "string") {
        throw new ProviderError("schema", "balasan tanpa teks")
      }
      return text
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
