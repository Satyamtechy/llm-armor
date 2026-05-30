export { armor, configureArmor } from './armor'
export { registerProvider } from './providers'
export { normalizeRawOutput, coerceTypes } from './normalizer'

export type {
  ArmorOptions,
  ArmorResult,
  ArmorMeta,
  ArmorError,
  ArmorErrorCode,
  ArmorConfig,
  ArmorStreamOptions,
  PartialResult,
  FallbackConfig,
  CoercionEntry,
  ValidationError,
  ProviderAdapter,
  ProviderConfig,
  ProviderMessage,
  ProviderResponse,
  ProviderCallOptions,
  ModelProvider,
} from './types'
