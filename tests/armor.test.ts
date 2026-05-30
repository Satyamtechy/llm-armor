import { describe, it, expect, beforeEach } from 'vitest'
import { z } from 'zod'
import { armor, configureArmor } from '../src/armor'
import { registerProvider } from '../src/providers'
import type { ProviderAdapter, ProviderMessage, ProviderCallOptions } from '../src/types'

/**
 * Mock provider that returns predefined responses in sequence.
 * Use this to simulate LLM behavior without API keys.
 */
function createMockProvider(responses: string[]): ProviderAdapter {
  let callIndex = 0
  return {
    name: 'custom',
    async call(_messages: ProviderMessage[], _options: ProviderCallOptions) {
      const content = responses[callIndex] ?? responses[responses.length - 1]!
      callIndex++
      return { content, model: 'mock', latency: 50 }
    },
  }
}

beforeEach(() => {
  configureArmor({ providers: { custom: { apiKey: 'test' } } })
})

describe('armor() — full flow', () => {
  const UserSchema = z.object({
    name: z.string(),
    email: z.string().email(),
    age: z.number().min(0),
  })

  it('passes on first attempt with clean JSON', async () => {
    const mock = createMockProvider(['{"name":"John","email":"john@test.com","age":28}'])
    registerProvider('custom', mock)

    const result = await armor({
      prompt: 'Extract user',
      schema: UserSchema,
      model: 'mock',
      provider: 'custom',
    })

    expect(result.success).toBe(true)
    expect(result.data).toEqual({ name: 'John', email: 'john@test.com', age: 28 })
    expect(result.meta.attempts).toBe(1)
  })

  it('handles markdown-wrapped response', async () => {
    const mock = createMockProvider(['```json\n{"name":"Alice","email":"a@b.com","age":25}\n```'])
    registerProvider('custom', mock)

    const result = await armor({
      prompt: 'Extract user',
      schema: UserSchema,
      model: 'mock',
      provider: 'custom',
    })

    expect(result.success).toBe(true)
    expect(result.data?.name).toBe('Alice')
    expect(result.meta.repaired).toContain('stripped_markdown_fences')
  })

  it('coerces wrong types when coerce=true', async () => {
    const mock = createMockProvider(['{"name":"Bob","email":"bob@x.com","age":"thirty"}'])
    registerProvider('custom', mock)

    // "thirty" can't be extracted as number, so validation fails
    // But "25" as string should work
    const mock2 = createMockProvider(['{"name":"Bob","email":"bob@x.com","age":"25"}'])
    registerProvider('custom', mock2)

    const result = await armor({
      prompt: 'Extract user',
      schema: UserSchema,
      model: 'mock',
      provider: 'custom',
      coerce: true,
    })

    expect(result.success).toBe(true)
    expect(result.data?.age).toBe(25)
    expect(result.meta.coerced.find(c => c.field === 'age')).toBeDefined()
  })

  it('retries with repair prompt on validation failure', async () => {
    const mock = createMockProvider([
      // Attempt 1: invalid email
      '{"name":"Jane","email":"not-an-email","age":30}',
      // Attempt 2: fixed
      '{"name":"Jane","email":"jane@test.com","age":30}',
    ])
    registerProvider('custom', mock)

    const result = await armor({
      prompt: 'Extract user',
      schema: UserSchema,
      model: 'mock',
      provider: 'custom',
      maxRetries: 2,
    })

    expect(result.success).toBe(true)
    expect(result.data?.email).toBe('jane@test.com')
    expect(result.meta.attempts).toBe(2)
  })

  it('returns error when all retries exhausted', async () => {
    const mock = createMockProvider([
      '{"name":"X","email":"bad","age":-1}',
      '{"name":"X","email":"bad","age":-1}',
      '{"name":"X","email":"bad","age":-1}',
    ])
    registerProvider('custom', mock)

    const result = await armor({
      prompt: 'Extract user',
      schema: UserSchema,
      model: 'mock',
      provider: 'custom',
      maxRetries: 2,
    })

    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('ALL_RETRIES_EXHAUSTED')
  })

  it('uses defaultValue when all retries fail', async () => {
    const mock = createMockProvider(['totally broken garbage'])
    registerProvider('custom', mock)

    const defaultUser = { name: 'Unknown', email: 'unknown@x.com', age: 0 }
    const result = await armor({
      prompt: 'Extract user',
      schema: UserSchema,
      model: 'mock',
      provider: 'custom',
      maxRetries: 0,
      defaultValue: defaultUser,
    })

    expect(result.success).toBe(true)
    expect(result.data).toEqual(defaultUser)
  })
})
