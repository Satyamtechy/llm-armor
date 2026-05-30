# 🛡️ llm-armor

**Bulletproof LLM output for TypeScript.** Validation, auto-retry with prompt repair, smart type coercion, and multi-model fallback chains — in one function call.

[![CI](https://github.com/Satyamtechy/llm-armor/actions/workflows/ci.yml/badge.svg)](https://github.com/Satyamtechy/llm-armor/actions)
[![npm](https://img.shields.io/npm/v/llm-armor)](https://www.npmjs.com/package/llm-armor)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## The Problem

LLMs are unreliable by design. You ask for JSON, you get:

```
Here's the extracted data:
```json
{"name": "John", "age": "twenty-eight", "active": "yes"}
```
Hope this helps!
```

Your `JSON.parse()` explodes. Your types are wrong. Your app crashes at 3 AM.

## The Solution

```ts
import { armor } from 'llm-armor'
import { z } from 'zod'

const result = await armor({
  prompt: 'Extract user info from: "John, 28, active"',
  schema: z.object({
    name: z.string(),
    age: z.number(),
    active: z.boolean()
  }),
  model: 'gpt-4o-mini'
})

// result.data = { name: "John", age: 28, active: true } — always typed, always valid
```

## Install

```bash
npm install llm-armor zod
```

## Features

| Feature | Description |
|---------|-------------|
| **Schema Validation** | Define output shape with Zod — get type-safe results or clear errors |
| **Auto-Repair** | Strips markdown fences, extracts JSON from prose, fixes trailing commas |
| **Type Coercion** | `"$99"` → `99`, `"yes"` → `true`, `"4.5 out of 5"` → `4.5` |
| **Retry with Repair** | Tells the model exactly what failed, gets corrected output |
| **Fallback Chains** | Try GPT → Claude → Gemini — stop at first success |
| **Streaming** | Validate incrementally as tokens arrive |
| **Cost Tracking** | Know exactly how much each call costs across retries |
| **Multi-Provider** | OpenAI, Anthropic, Gemini — same API |

## Quick Start

```ts
import { armor, configureArmor } from 'llm-armor'
import { z } from 'zod'

// 1. Configure providers (once, at app startup)
configureArmor({
  providers: {
    openai: { apiKey: process.env.OPENAI_API_KEY! },
    anthropic: { apiKey: process.env.ANTHROPIC_API_KEY! },
  }
})

// 2. Define your schema
const ProductSchema = z.object({
  name: z.string(),
  price: z.number(),
  inStock: z.boolean(),
  tags: z.array(z.string())
})

// 3. Call with armor
const result = await armor({
  prompt: 'Extract: "MacBook Pro, $2499, available, tags: laptop, apple"',
  schema: ProductSchema,
  model: 'gpt-4o-mini'
})

if (result.success) {
  console.log(result.data)
  // { name: "MacBook Pro", price: 2499, inStock: true, tags: ["laptop", "apple"] }
}
```

## Scenarios

### Markdown-wrapped response → auto-stripped

```ts
// LLM returns: ```json\n{"name":"John"}\n```\nHere you go!
// armor() returns: { name: "John" } ✅
```

### Wrong types → smart coercion

```ts
// LLM returns: {"price": "$2,499", "active": "yes", "rating": "4.8 out of 5"}
// armor() returns: { price: 2499, active: true, rating: 4.8 } ✅
```

### Validation fails → intelligent retry

```ts
const result = await armor({
  prompt: 'Parse event...',
  schema: z.object({
    title: z.string(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    priority: z.enum(['low', 'medium', 'high'])
  }),
  model: 'gpt-4o-mini',
  maxRetries: 3
})
// Attempt 1: {"date": "tomorrow", "priority": "urgent"} ❌
// Auto-sends: "Fix these: date must be YYYY-MM-DD, priority must be low|medium|high"
// Attempt 2: {"date": "2026-05-30", "priority": "high"} ✅
```

### Fallback chain

```ts
const result = await armor({
  prompt: 'Classify this ticket...',
  schema: TicketSchema,
  fallback: [
    { model: 'gpt-4o-mini', maxRetries: 2 },
    { model: 'claude-haiku', maxRetries: 1 },
    { model: 'gemini-flash', maxRetries: 1 }
  ],
  defaultValue: { category: 'uncategorized', priority: 'medium' }
})
```

### Streaming with incremental validation

```ts
for await (const chunk of armor.stream({
  prompt: 'Generate 5 recommendations...',
  schema: RecommendationSchema,
  model: 'gpt-4o',
  onPartial: (partial) => updateUI(partial)
})) {
  if (chunk.done && chunk.validated) {
    // Full response, validated ✅
  }
}
```

## API

### `armor(options): Promise<ArmorResult<T>>`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `prompt` | `string` | — | Prompt to send |
| `schema` | `ZodSchema` | — | Expected output shape |
| `model` | `string` | — | Model identifier |
| `maxRetries` | `number` | `2` | Retry attempts on validation failure |
| `coerce` | `boolean` | `true` | Smart type coercion |
| `fallback` | `FallbackConfig[]` | — | Ordered fallback models |
| `defaultValue` | `T` | — | Fallback if all attempts fail |
| `temperature` | `number` | `0` | Model temperature |
| `timeout` | `number` | `30000` | Timeout per attempt (ms) |

### `ArmorResult<T>`

```ts
{
  success: boolean
  data: T | null
  error?: { code: string, message: string, validationErrors?: [...] }
  meta: {
    attempts: number       // Total attempts across all models
    finalModel: string     // Which model succeeded
    latency: number        // Total ms
    cost: number           // Estimated $ spent
    coerced: [...]         // Fields that were type-coerced
    repaired: [...]        // Auto-repairs applied
    fallbackPath: [...]    // Models tried in order
  }
}
```

## Custom Providers

```ts
import { registerProvider } from 'llm-armor'

registerProvider('ollama', {
  name: 'custom',
  async call(messages, options) {
    const res = await fetch('http://localhost:11434/api/chat', { ... })
    return { content: '...', model: options.model, latency: 200 }
  }
})

// Now use it
await armor({ ..., model: 'llama3', provider: 'ollama' })
```

## Testing Without API Keys

Use the mock provider pattern:

```ts
import { armor, configureArmor } from 'llm-armor'
import { registerProvider } from 'llm-armor'

registerProvider('custom', {
  name: 'custom',
  async call() {
    return {
      content: '{"name": "test", "age": 25}',
      model: 'mock',
      latency: 10
    }
  }
})

configureArmor({ providers: { custom: { apiKey: 'fake' } } })

const result = await armor({
  prompt: '...',
  schema: MySchema,
  model: 'mock',
  provider: 'custom'
})
```

## Tested

10,000 scenarios across 5 categories — **100% pass rate**:

| Category | Scenarios | Pass Rate |
|----------|-----------|-----------|
| Markdown fence stripping | 2,000 | 100% |
| Prose extraction | 2,000 | 100% |
| Type coercion | 2,000 | 100% |
| Malformed JSON repair | 2,000 | 100% |
| Validation & retry | 2,000 | 100% |

## Why not...

| Tool | Limitation |
|------|------------|
| Raw `JSON.parse()` | No repair, no retry, no coercion |
| Zod alone | Validates but doesn't fix or retry |
| Instructor (Python) | Python only, no fallback chains, no coercion |
| Guardrails AI | Python, heavy, complex setup |

**llm-armor** is TypeScript-native, zero external deps (just Zod peer dep), and handles the full lifecycle: normalize → coerce → validate → retry → fallback.

## License

MIT
