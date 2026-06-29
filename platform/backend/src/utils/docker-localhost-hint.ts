import { isLoopbackRedirectUri } from "@/utils/network";

/**
 * Substrings that appear in Node's `fetch` errors when a TCP connection cannot
 * be established (as opposed to an HTTP error response). `fetch failed` is the
 * generic wrapper message; the others are the underlying libuv codes that may
 * surface depending on the platform and Node version.
 */
const CONNECTION_ERROR_MARKERS = [
  "fetch failed",
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EHOSTUNREACH",
];

/**
 * When connecting to a self-hosted provider (e.g. Ollama) fails and the base
 * URL points at localhost, this is almost always the Docker networking trap:
 * a server running inside a container reaches itself at `localhost`, not the
 * host machine where the provider is listening. Returns a hint suggesting the
 * `host.docker.internal` equivalent, or null when the situation doesn't apply
 * (non-connection error, non-loopback URL, or an unparseable URL).
 */
export function dockerLocalhostConnectionHint(params: {
  baseUrl: string | null | undefined;
  errorMessage: string;
}): string | null {
  const { baseUrl, errorMessage } = params;
  if (!baseUrl) return null;

  const looksLikeConnectionFailure = CONNECTION_ERROR_MARKERS.some((marker) =>
    errorMessage.includes(marker),
  );
  if (!looksLikeConnectionFailure) return null;

  if (!isLoopbackRedirectUri(baseUrl)) return null;

  let suggestedUrl: string;
  try {
    const url = new URL(baseUrl);
    url.hostname = "host.docker.internal";
    suggestedUrl = url.toString();
  } catch {
    return null;
  }

  return `If this server is running in Docker, "localhost" points at the container itself, not your host machine — try using ${suggestedUrl} instead.`;
}
