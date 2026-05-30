import type { ZodSchema } from 'zod'

// ─── Types ──────────────────────────────────────────────────────────────────

interface CacheEntry<T = unknown> {
  value: T
  expiresAt: number
}

interface CacheOptions {
  maxSize?: number
  ttl?: number
}

interface ArmorCache {
  get<T>(key: string): T | undefined
  set<T>(key: string, value: T, ttl?: number): void
  clear(): void
  size: number
}

// ─── Simple hash (FNV-1a 32-bit) ───────────────────────────────────────────

function hashKey(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

// ─── LRU Cache ──────────────────────────────────────────────────────────────

export function createCache(options: CacheOptions = {}): ArmorCache {
  const { maxSize = 100, ttl = 300_000 } = options
  const store = new Map<string, CacheEntry>()

  function evict(): void {
    if (store.size >= maxSize) {
      const firstKey = store.keys().next().value as string
      store.delete(firstKey)
    }
  }

  return {
    get<T>(key: string): T | undefined {
      const entry = store.get(key)
      if (!entry) return undefined
      if (Date.now() > entry.expiresAt) {
        store.delete(key)
        return undefined
      }
      // Move to end (most recently used)
      store.delete(key)
      store.set(key, entry)
      return entry.value as T
    },

    set<T>(key: string, value: T, entryTtl?: number): void {
      store.delete(key)
      evict()
      store.set(key, { value, expiresAt: Date.now() + (entryTtl ?? ttl) })
    },

    clear(): void {
      store.clear()
    },

    get size() {
      return store.size
    },
  }
}

// ─── Cache Key Generation ───────────────────────────────────────────────────

export function buildCacheKey(prompt: string, model: string, schema: ZodSchema): string {
  const shape = JSON.stringify((schema as { _def?: unknown })._def ?? '')
  return hashKey(`${prompt}|${model}|${shape}`)
}

// ─── Module-level default cache ─────────────────────────────────────────────

let defaultCache: ArmorCache | null = null

export function getCached<T>(prompt: string, model: string, schema: ZodSchema): T | undefined {
  if (!defaultCache) return undefined
  const key = buildCacheKey(prompt, model, schema)
  return defaultCache.get<T>(key)
}

export function setCached<T>(prompt: string, model: string, schema: ZodSchema, value: T, ttl?: number): void {
  if (!defaultCache) return
  const key = buildCacheKey(prompt, model, schema)
  defaultCache.set(key, value, ttl)
}

export function initDefaultCache(options: CacheOptions): ArmorCache {
  if (!defaultCache) {
    defaultCache = createCache(options)
  }
  return defaultCache
}
