import type { ZodSchema, ZodTypeDef, z } from 'zod'
import type { ArmorOptions, ArmorResult, ArmorStreamOptions, ArmorConfig, PartialResult } from './types'
import { executeFallbackChain } from './fallback'
import { executeWithRetry } from './retry'
import { resolveProvider } from './providers'
import { normalizeRawOutput, safeParse } from './normalizer'
import { getCached, setCached, initDefaultCache } from './cache'

// ─── Global Config ──────────────────────────────────────────────────────────

let globalConfig: ArmorConfig = { providers: {} }

export function configureArmor(config: ArmorConfig): void {
  globalConfig = config
}

export function getConfig(): ArmorConfig {
  return globalConfig
}

// ─── Main armor() ───────────────────────────────────────────────────────────

export async function armor<T extends ZodSchema<unknown, ZodTypeDef, unknown>>(
  options: ArmorOptions<T>
): Promise<ArmorResult<z.infer<T>>> {
  const {
    prompt,
    schema,
    model,
    systemPrompt = buildSystemPrompt(schema),
    temperature = globalConfig.defaults?.temperature ?? 0,
    timeout = globalConfig.defaults?.timeout ?? 30000,
    maxRetries = globalConfig.defaults?.maxRetries ?? 2,
    coerce = globalConfig.defaults?.coerce ?? true,
    fallback,
    defaultValue,
    cache,
  } = options

  // Initialize cache if enabled
  if (cache?.enabled) {
    initDefaultCache({ maxSize: cache.maxSize, ttl: cache.ttl })
  }

  // Check cache
  const cacheModel = model ?? fallback?.[0]?.model ?? 'unknown'
  if (cache?.enabled) {
    const cached = getCached<z.infer<T>>(prompt, cacheModel, schema)
    if (cached !== undefined) {
      return {
        success: true,
        data: cached,
        meta: { attempts: 0, finalModel: cacheModel, latency: 0, cost: 0, coerced: [], repaired: [], fallbackPath: [], cached: true },
      }
    }
  }

  try {
    // If fallback chain is provided, use it
    if (fallback && fallback.length > 0) {
      const chain = model
        ? [{ model, provider: options.provider, maxRetries }, ...fallback]
        : fallback

      const result = await executeFallbackChain<z.infer<T>>({
        schema,
        systemPrompt,
        userPrompt: prompt,
        chain,
        coerce,
        temperature,
        timeout,
      })

      if (!result.success && defaultValue !== undefined) {
        return { success: true, data: defaultValue, meta: { ...result.meta, cached: false } }
      }
      if (result.success && cache?.enabled) {
        setCached(prompt, cacheModel, schema, result.data, cache.ttl)
      }
      return { ...result, meta: { ...result.meta, cached: false } }
    }

    // Single model execution
    if (!model) throw new Error('Either "model" or "fallback" must be provided')

    const provider = resolveProvider(options.provider ?? detectProvider(model))
    const result = await executeWithRetry({
      schema,
      provider,
      callOptions: { model, temperature, timeout },
      systemPrompt,
      userPrompt: prompt,
      maxRetries,
      coerce,
    })

    if (result.success) {
      const data = result.data as z.infer<T>
      if (cache?.enabled) {
        setCached(prompt, model, schema, data, cache.ttl)
      }
      return {
        success: true,
        data,
        meta: {
          attempts: result.attempts,
          finalModel: model,
          latency: result.latency,
          cost: estimateSimpleCost(model, result.attempts),
          coerced: result.coerced,
          repaired: result.repaired,
          fallbackPath: [`${model}(${result.attempts}x)`],
          cached: false,
        },
      }
    }

    // All retries exhausted
    if (defaultValue !== undefined) {
      return {
        success: true,
        data: defaultValue,
        meta: {
          attempts: result.attempts,
          finalModel: model,
          latency: result.latency,
          cost: estimateSimpleCost(model, result.attempts),
          coerced: result.coerced,
          repaired: result.repaired,
          fallbackPath: [`${model}(${result.attempts}x)`],
          cached: false,
        },
      }
    }

    return {
      success: false,
      data: null,
      error: {
        code: 'ALL_RETRIES_EXHAUSTED',
        message: `Failed after ${result.attempts} attempts with model ${model}`,
        validationErrors: result.errors,
        lastRawOutput: result.rawOutput,
      },
      meta: {
        attempts: result.attempts,
        finalModel: model,
        latency: result.latency,
        cost: estimateSimpleCost(model, result.attempts),
        coerced: result.coerced,
        repaired: result.repaired,
        fallbackPath: [`${model}(${result.attempts}x)`],
        cached: false,
      },
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return {
      success: false,
      data: null,
      error: { code: 'PROVIDER_ERROR', message },
      meta: { attempts: 0, finalModel: model ?? 'unknown', latency: 0, cost: 0, coerced: [], repaired: [], fallbackPath: [], cached: false },
    }
  }
}

// ─── armor.stream() ─────────────────────────────────────────────────────────

armor.stream = async function* <T extends ZodSchema<unknown, ZodTypeDef, unknown>>(
  options: ArmorStreamOptions<T>
): AsyncGenerator<PartialResult<z.infer<T>>> {
  const {
    prompt,
    schema,
    model,
    systemPrompt = buildSystemPrompt(schema),
    temperature = 0,
    timeout = 30000,
    onPartial,
    onError,
  } = options

  if (!model) throw new Error('"model" is required for streaming')

  const provider = resolveProvider(options.provider ?? detectProvider(model))
  if (!provider.stream) throw new Error(`Provider ${provider.name} does not support streaming`)

  const messages = [
    { role: 'system' as const, content: systemPrompt },
    { role: 'user' as const, content: prompt },
  ]

  let buffer = ''

  for await (const chunk of provider.stream(messages, { model, temperature, timeout })) {
    buffer += chunk

    // Try to parse partial JSON
    const { json } = normalizeRawOutput(buffer)
    const parsed = safeParse(json) ?? safeParse(json + '}') ?? safeParse(json + ']}')

    if (parsed !== null) {
      const partial = parsed as Partial<z.infer<T>> & object
      const validation = schema.safeParse(partial)

      if (validation.success) {
        onPartial?.(validation.data as Partial<z.infer<T>>)
        yield { partial: validation.data as Partial<z.infer<T>>, done: true, validated: true }
        return
      }

      onPartial?.(partial as Partial<z.infer<T>>)
      yield { partial: partial as Partial<z.infer<T>>, done: false, validated: false }
    }
  }

  // Final attempt with complete buffer
  const { json } = normalizeRawOutput(buffer)
  const parsed = safeParse(json)
  if (parsed !== null) {
    const validation = schema.safeParse(parsed)
    if (validation.success) {
      yield { partial: validation.data as Partial<z.infer<T>>, done: true, validated: true }
      return
    }
    onError?.({ code: 'VALIDATION_FAILED', message: 'Stream completed but validation failed' })
  } else {
    onError?.({ code: 'PARSE_ERROR', message: 'Stream completed but JSON parsing failed' })
  }

  yield { partial: {} as Partial<z.infer<T>>, done: true, validated: false }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function buildSystemPrompt(schema: ZodSchema): string {
  return `You are a structured data extraction assistant. Respond with ONLY valid JSON that matches the required schema. No markdown fences, no explanations, no extra text. Just the JSON object.`
}

function detectProvider(model: string): string {
  if (model.startsWith('gpt') || model.startsWith('o1') || model.startsWith('o3')) return 'openai'
  if (model.startsWith('claude')) return 'anthropic'
  if (model.startsWith('gemini')) return 'gemini'
  if (model.includes('llama') || model.includes('mistral')) return 'ollama'
  if (model.includes('groq')) return 'groq'
  if (model.includes('together')) return 'together'
  return 'openai'
}

function estimateSimpleCost(model: string, attempts: number): number {
  const rates: Record<string, number> = {
    'gpt-4o': 0.005, 'gpt-4o-mini': 0.0003, 'claude-sonnet': 0.003,
    'claude-haiku': 0.0005, 'gemini-flash': 0.0002, 'gemini-pro': 0.002,
  }
  return Math.round((rates[model] ?? 0.002) * attempts * 10000) / 10000
}
