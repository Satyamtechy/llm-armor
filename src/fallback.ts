import type { ZodSchema } from 'zod'
import type { ArmorResult, ArmorMeta, FallbackConfig, ProviderAdapter, CoercionEntry } from './types'
import { executeWithRetry, type RetryContext } from './retry'
import { resolveProvider } from './providers'

export interface FallbackOptions {
  schema: ZodSchema
  systemPrompt: string
  userPrompt: string
  chain: FallbackConfig[]
  coerce: boolean
  temperature: number
  timeout: number
}

/**
 * Tries models in order. Stops at first successful validation.
 * Tracks full execution path for debugging.
 */
export async function executeFallbackChain<T>(options: FallbackOptions): Promise<ArmorResult<T>> {
  const fallbackPath: string[] = []
  let totalAttempts = 0
  let totalLatency = 0
  let allCoerced: CoercionEntry[] = []
  let allRepairs: string[] = []
  let lastRawOutput = ''

  for (const step of options.chain) {
    const provider: ProviderAdapter = resolveProvider(step.provider ?? detectProvider(step.model))
    const maxRetries = step.maxRetries ?? 1

    const ctx: RetryContext = {
      schema: options.schema,
      provider,
      callOptions: {
        model: step.model,
        temperature: options.temperature,
        timeout: options.timeout,
      },
      systemPrompt: options.systemPrompt,
      userPrompt: options.userPrompt,
      maxRetries,
      coerce: options.coerce,
    }

    const result = await executeWithRetry(ctx)
    totalAttempts += result.attempts
    totalLatency += result.latency
    allCoerced = [...allCoerced, ...result.coerced]
    allRepairs = [...new Set([...allRepairs, ...result.repaired])]
    lastRawOutput = result.rawOutput
    fallbackPath.push(`${step.model}(${result.attempts}x)`)

    if (result.success) {
      const meta: ArmorMeta = {
        attempts: totalAttempts,
        finalModel: step.model,
        latency: totalLatency,
        cost: estimateCost(step.model, totalAttempts),
        coerced: allCoerced,
        repaired: allRepairs,
        fallbackPath,
      }
      return { success: true, data: result.data as T, meta }
    }
  }

  // All fallbacks exhausted
  const meta: ArmorMeta = {
    attempts: totalAttempts,
    finalModel: options.chain[options.chain.length - 1]?.model ?? 'unknown',
    latency: totalLatency,
    cost: estimateCost('unknown', totalAttempts),
    coerced: allCoerced,
    repaired: allRepairs,
    fallbackPath,
  }

  return {
    success: false,
    data: null,
    error: {
      code: 'ALL_FALLBACKS_EXHAUSTED',
      message: `All ${options.chain.length} models failed validation after ${totalAttempts} total attempts`,
      lastRawOutput,
    },
    meta,
  }
}

/**
 * Detects provider from model name.
 */
function detectProvider(model: string): string {
  if (model.startsWith('gpt') || model.startsWith('o1') || model.startsWith('o3')) return 'openai'
  if (model.startsWith('claude')) return 'anthropic'
  if (model.startsWith('gemini')) return 'gemini'
  return 'openai'
}

/**
 * Rough cost estimation based on model and attempts.
 */
function estimateCost(model: string, attempts: number): number {
  const costPerCall: Record<string, number> = {
    'gpt-4o': 0.005,
    'gpt-4o-mini': 0.0003,
    'gpt-4-turbo': 0.01,
    'claude-sonnet': 0.003,
    'claude-haiku': 0.0005,
    'gemini-flash': 0.0002,
    'gemini-pro': 0.002,
  }
  const baseCost = costPerCall[model] ?? 0.002
  return Math.round(baseCost * attempts * 10000) / 10000
}
