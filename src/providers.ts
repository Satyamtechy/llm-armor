import type { ProviderAdapter, ProviderCallOptions, ProviderMessage, ProviderResponse, ModelProvider } from './types'
import { getConfig } from './armor'

// ─── OpenAI Adapter ─────────────────────────────────────────────────────────

const openaiAdapter: ProviderAdapter = {
  name: 'openai',

  async call(messages: ProviderMessage[], options: ProviderCallOptions): Promise<ProviderResponse> {
    const config = getConfig().providers.openai
    if (!config?.apiKey) throw new Error('OpenAI API key not configured. Call configureArmor() first.')

    const start = Date.now()
    const baseUrl = config.baseUrl ?? 'https://api.openai.com/v1'

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: options.model,
        messages,
        temperature: options.temperature ?? 0,
        max_tokens: options.maxTokens,
        response_format: { type: 'json_object' },
      }),
      signal: options.timeout ? AbortSignal.timeout(options.timeout) : undefined,
    })

    if (!response.ok) {
      const err = await response.text()
      throw new Error(`OpenAI error ${response.status}: ${err}`)
    }

    const data = await response.json() as {
      choices: { message: { content: string } }[]
      usage?: { prompt_tokens: number; completion_tokens: number }
    }

    return {
      content: data.choices[0]?.message.content ?? '',
      model: options.model,
      usage: data.usage ? { promptTokens: data.usage.prompt_tokens, completionTokens: data.usage.completion_tokens } : undefined,
      latency: Date.now() - start,
    }
  },

  async *stream(messages: ProviderMessage[], options: ProviderCallOptions): AsyncIterable<string> {
    const config = getConfig().providers.openai
    if (!config?.apiKey) throw new Error('OpenAI API key not configured.')

    const baseUrl = config.baseUrl ?? 'https://api.openai.com/v1'

    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: options.model,
        messages,
        temperature: options.temperature ?? 0,
        stream: true,
        response_format: { type: 'json_object' },
      }),
      signal: options.timeout ? AbortSignal.timeout(options.timeout) : undefined,
    })

    if (!response.ok || !response.body) throw new Error(`OpenAI stream error: ${response.status}`)

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (!line.startsWith('data: ') || line === 'data: [DONE]') continue
        try {
          const json = JSON.parse(line.slice(6)) as { choices: { delta: { content?: string } }[] }
          const content = json.choices[0]?.delta.content
          if (content) yield content
        } catch { /* skip malformed SSE lines */ }
      }
    }
  },
}

// ─── Anthropic Adapter ──────────────────────────────────────────────────────

const anthropicAdapter: ProviderAdapter = {
  name: 'anthropic',

  async call(messages: ProviderMessage[], options: ProviderCallOptions): Promise<ProviderResponse> {
    const config = getConfig().providers.anthropic
    if (!config?.apiKey) throw new Error('Anthropic API key not configured.')

    const start = Date.now()
    const baseUrl = config.baseUrl ?? 'https://api.anthropic.com/v1'

    // Anthropic uses system separately
    const system = messages.find(m => m.role === 'system')?.content ?? ''
    const userMessages = messages.filter(m => m.role !== 'system')

    const response = await fetch(`${baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: options.model,
        system,
        messages: userMessages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
        max_tokens: options.maxTokens ?? 4096,
        temperature: options.temperature ?? 0,
      }),
      signal: options.timeout ? AbortSignal.timeout(options.timeout) : undefined,
    })

    if (!response.ok) {
      const err = await response.text()
      throw new Error(`Anthropic error ${response.status}: ${err}`)
    }

    const data = await response.json() as {
      content: { type: string; text: string }[]
      usage?: { input_tokens: number; output_tokens: number }
    }

    return {
      content: data.content.find(c => c.type === 'text')?.text ?? '',
      model: options.model,
      usage: data.usage ? { promptTokens: data.usage.input_tokens, completionTokens: data.usage.output_tokens } : undefined,
      latency: Date.now() - start,
    }
  },
}

// ─── Gemini Adapter ─────────────────────────────────────────────────────────

const geminiAdapter: ProviderAdapter = {
  name: 'gemini',

  async call(messages: ProviderMessage[], options: ProviderCallOptions): Promise<ProviderResponse> {
    const config = getConfig().providers.gemini
    if (!config?.apiKey) throw new Error('Gemini API key not configured.')

    const start = Date.now()
    const baseUrl = config.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta'
    const model = options.model

    // Convert messages to Gemini format
    const system = messages.find(m => m.role === 'system')?.content ?? ''
    const contents = messages
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }))

    const response = await fetch(`${baseUrl}/models/${model}:generateContent?key=${config.apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents,
        generationConfig: {
          temperature: options.temperature ?? 0,
          maxOutputTokens: options.maxTokens,
          responseMimeType: 'application/json',
        },
      }),
      signal: options.timeout ? AbortSignal.timeout(options.timeout) : undefined,
    })

    if (!response.ok) {
      const err = await response.text()
      throw new Error(`Gemini error ${response.status}: ${err}`)
    }

    const data = await response.json() as {
      candidates: { content: { parts: { text: string }[] } }[]
      usageMetadata?: { promptTokenCount: number; candidatesTokenCount: number }
    }

    return {
      content: data.candidates[0]?.content.parts[0]?.text ?? '',
      model: options.model,
      usage: data.usageMetadata
        ? { promptTokens: data.usageMetadata.promptTokenCount, completionTokens: data.usageMetadata.candidatesTokenCount }
        : undefined,
      latency: Date.now() - start,
    }
  },
}

// ─── Registry ───────────────────────────────────────────────────────────────

const adapters: Record<string, ProviderAdapter> = {
  openai: openaiAdapter,
  anthropic: anthropicAdapter,
  gemini: geminiAdapter,
}

export function resolveProvider(name: ModelProvider | string): ProviderAdapter {
  const adapter = adapters[name]
  if (!adapter) throw new Error(`Unknown provider: ${name}. Available: ${Object.keys(adapters).join(', ')}`)
  return adapter
}

export function registerProvider(name: string, adapter: ProviderAdapter): void {
  adapters[name] = adapter
}
