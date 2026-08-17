import type { SupportedProvider } from "@archestra/shared";

// ===== Exports =====

/**
 * Providers whose direct-call transport is verified to forward
 * `application/pdf` file parts to the vendor API.
 *
 * Membership is about the TRANSPORT, not the model: `ollama-native`'s
 * converter silently drops non-image file parts, so a "vision" model there
 * would transcribe nothing while appearing configured — it must never be
 * selectable. The OpenAI-compatible transports (azure, openrouter, vllm)
 * serialize PDF file parts faithfully; whether the endpoint's model accepts
 * them is endpoint-dependent and surfaces as a per-document warning.
 */
const PDF_INPUT_PROVIDERS: ReadonlySet<SupportedProvider> = new Set([
  "anthropic",
  "openai",
  "gemini",
  "bedrock",
  "azure",
  "openrouter",
  "vllm",
]);

/** Whether a provider's transport can carry PDF input for OCR transcription. */
export function providerSupportsPdfInput(
  provider: SupportedProvider,
): boolean {
  return PDF_INPUT_PROVIDERS.has(provider);
}
