import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Agent } from "undici";

type StreamableHttpOptions = NonNullable<
  ConstructorParameters<typeof StreamableHTTPClientTransport>[1]
>;

/**
 * A streamable-http MCP transport whose requests travel a tunnel through the
 * server's cluster API server instead of being dialed, for a server in an
 * environment's own cluster. The URL's host is only a name: nothing resolves
 * it.
 *
 * The transport owns the tunnel. Closing the transport destroys it, which
 * closes every stream the tunnel opened.
 */
export class PodTunnelStreamableHttpTransport extends StreamableHTTPClientTransport {
  constructor(
    url: URL,
    options: Omit<StreamableHttpOptions, "fetch">,
    private readonly tunnel: Agent,
  ) {
    super(url, {
      ...options,
      fetch: (input, init) =>
        // `dispatcher` is undici's extension to the fetch options.
        fetch(input, { ...init, dispatcher: tunnel } as RequestInit),
    });
  }

  override async close(): Promise<void> {
    try {
      await super.close();
    } finally {
      await this.tunnel.destroy();
    }
  }
}
