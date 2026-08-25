import { providerSearchTerms, type SupportedProvider } from "@archestra/shared";

/**
 * Everything a provider entry should be findable by, as one string to match a
 * search query against.
 *
 * `labels` are the names the entry renders under — its built-in label, the
 * organization's own name for it, whatever subtext the surface shows — and the
 * aliases come from the shared catalog. Aliases matter for an entry named after
 * the path it serves rather than a vendor: the OpenAI-compatible entry is how
 * llama.cpp, LM Studio, SGLang, TGI and LocalAI connect, and an operator
 * searches for the server they run.
 */
export function providerSearchHaystack({
  provider,
  labels,
}: {
  provider: SupportedProvider;
  labels: Array<string | null | undefined>;
}): string {
  return [...labels, providerSearchTerms(provider)].filter(Boolean).join(" ");
}
