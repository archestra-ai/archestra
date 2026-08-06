/**
 * The proxy relays provider errors instead of retrying them: callers (chat's
 * AI SDK, native Anthropic/OpenAI clients) run their own bounded retry policy
 * on the relayed status, and SDK-internal retries stack multiplicatively on
 * top of that while keeping the request silently open. The openai SDK (v6)
 * also honors a 429's Retry-After verbatim with no upper bound, so a
 * daily-quota rate limit whose reset lies hours away slept inside the request
 * and hung chat streams indefinitely instead of surfacing the error.
 */
export const PROXY_SDK_MAX_RETRIES = 0;
