// Unified copy for a provider API key whose remaining usage balance is too low
// (out of credit or over a usage/spend limit). Shared so the connection-page
// warning (frontend) and the LLM-proxy error (backend) stay in sync.

export const PROVIDER_BILLING_BLOCK_TITLE =
  "Provider API key remaining usage balance is too low";

export const PROVIDER_BILLING_BLOCK_BODY =
  "Please contact your administrator or try again later.";
