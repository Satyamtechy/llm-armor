import type { ZodSchema, ZodTypeDef, z } from 'zod'

// ─── Provider Types ─────────────────────────────────────────────────────────

export type ModelProvider = 'openai' | 'anthropic' | 'gemini' | 'ollama' | 'groq' | 'together' | 'custom'

export interface ProviderConfig {
  apiKey: string
  baseUrl?: string
  defaultModel?: string
}

export interface ProviderMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ProviderResponse {
  content: string
  model: string
  usage?: { promptTokens: number; completionTokens: number }
  latency: number
}

export interface ProviderAdapter {
  name: ModelProvider
  call(messages: ProviderMessage[], options: ProviderCallOptions): Promise<ProviderResponse>
  stream?(messages: ProviderMessage[], options: ProviderCallOptions): AsyncIterable<string>
}

export interface ProviderCallOptions {
  model: string
  temperature?: number
  maxTokens?: number
  timeout?: number
}

// ─── Armor Options ──────────────────────────────────────────────────────────

export interface ArmorOptions<T extends ZodSchema<unknown, ZodTypeDef, unknown>> {
  prompt: string
  schema: T
  model?: string
  provider?: ModelProvider
  systemPrompt?: string
  temperature?: number
  maxTokens?: number
  timeout?: number
  maxRetries?: number
  coerce?: boolean
  fallback?: FallbackConfig[]
  defaultValue?: z.infer<T>
  cache?: { enabled: boolean; ttl?: number; maxSize?: number }
}

export interface FallbackConfig {
  model: string
  provider?: ModelProvider
  maxRetries?: number
}

// ─── Armor Result ───────────────────────────────────────────────────────────

export interface ArmorResult<T> {
  success: boolean
  data: T | null
  error?: ArmorError
  meta: ArmorMeta
}

export interface ArmorMeta {
  attempts: number
  finalModel: string
  latency: number
  cost: number
  coerced: CoercionEntry[]
  repaired: string[]
  fallbackPath: string[]
  cached: boolean
}

export interface CoercionEntry {
  field: string
  from: unknown
  to: unknown
  rule: string
}

export interface ArmorError {
  code: ArmorErrorCode
  message: string
  validationErrors?: ValidationError[]
  lastRawOutput?: string
}

export type ArmorErrorCode =
  | 'VALIDATION_FAILED'
  | 'ALL_RETRIES_EXHAUSTED'
  | 'ALL_FALLBACKS_EXHAUSTED'
  | 'PROVIDER_ERROR'
  | 'TIMEOUT'
  | 'PARSE_ERROR'

export interface ValidationError {
  path: string
  message: string
  expected: string
  received: string
}

// ─── Stream Types ───────────────────────────────────────────────────────────

export interface ArmorStreamOptions<T extends ZodSchema<unknown, ZodTypeDef, unknown>> extends ArmorOptions<T> {
  onPartial?: (partial: Partial<z.infer<T>>) => void
  onError?: (error: ArmorError) => void
}

export interface PartialResult<T> {
  partial: Partial<T>
  done: boolean
  validated: boolean
}

// ─── Global Config ──────────────────────────────────────────────────────────

export interface ArmorConfig {
  providers: Partial<Record<ModelProvider, ProviderConfig>>
  defaults?: {
    maxRetries?: number
    temperature?: number
    timeout?: number
    coerce?: boolean
  }
}
