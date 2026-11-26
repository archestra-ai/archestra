import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { UpstreamHttpTarget } from "@/clients/mcp-files/stateless-upstream";

/**
 * The SDK's Streamable HTTP transport, keeping the address, headers and fetch
 * it was built with.
 *
 * Requests the pooled 2025-11-25 session cannot carry (see
 * `mcp-files/stateless-upstream.ts`) go to the same server with exactly the
 * same credentials; reading them back from here means they are never resolved
 * a second, possibly different, way.
 */
export class UpstreamHttpTransport extends StreamableHTTPClientTransport {
  readonly httpTarget: UpstreamHttpTarget;

  constructor(params: {
    url: URL;
    sessionId?: string;
    headers: Record<string, string>;
    credentialHeaders: Record<string, string>;
    fetch: FetchLike;
    signsRequests: boolean;
  }) {
    super(params.url, {
      sessionId: params.sessionId,
      requestInit: { headers: new Headers(params.headers) },
      fetch: params.fetch,
    });
    this.httpTarget = {
      url: params.url,
      headers: params.headers,
      credentialHeaders: params.credentialHeaders,
      fetch: params.fetch,
      signsRequests: params.signsRequests,
    };
  }
}
