# Changelog

## 0.1.0 (2026-05-30)

### Features

- `armor()` — main function with schema validation, auto-retry, and fallback chains
- `armor.stream()` — streaming with incremental JSON validation
- Smart type coercion: currency strings, booleans, ratings, CSV arrays
- JSON normalization: markdown fences, prose extraction, trailing commas, unquoted keys, comment stripping
- Multi-provider support: OpenAI, Anthropic, Gemini
- `registerProvider()` — add custom/local model providers
- Cost estimation per call
- 10,000-scenario test suite
