/**
 * Build the error thrown for a non-OK HTTP response from an upstream
 * provider, for the fetch-based adapters that don't go through a provider
 * SDK (the SDKs attach the HTTP status themselves).
 *
 * The status must live on the error as a number, not just in the message
 * text: the proxy's error boundary (`handleError` in llm-proxy-helpers)
 * reads `status` to relay the provider's real HTTP code — without it a
 * provider 429/503 surfaces as a 500 and gets reported to error tracking
 * as a crash of ours instead of being classified as an expected
 * client/upstream failure. The `error` payload gives the boundary the
 * provider-error shape it uses to mark 5xx relays as upstream faults.
 */
export function upstreamHttpError(
  message: string,
  status: number,
): Error & { status: number; error: { message: string } } {
  return Object.assign(new Error(message), {
    status,
    error: { message },
  });
}
