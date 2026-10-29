import { createServer, type ServerResponse } from "node:http";
import { ChatErrorCode, OpenAIErrorTypes } from "@archestra/shared";
import { expect, test } from "vitest";
import { mapProviderError } from "./errors";

test("a real upstream stream disconnect offers a retryable network error", async () => {
  let upstream!: ServerResponse;
  const server = createServer((_request, response) => {
    upstream = response;
    response.writeHead(200, {
      "content-type": "text/plain",
      "content-length": "100",
    });
    response.write("partial");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a local TCP listener");
    }
    const response = await fetch(`http://127.0.0.1:${address.port}`);
    upstream.destroy();
    const error = await response.text().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(TypeError);

    const mapped = mapProviderError(error, "openai");
    expect(mapped.code).toBe(ChatErrorCode.NetworkError);
    expect(mapped.isRetryable).toBe(true);
    expect(mapped.originalError?.message).toBe(
      "Upstream provider closed the connection unexpectedly",
    );

    // A proxy serializes the transport failure into the provider's stream
    // envelope before the chat client sees it.
    const relay = {
      type: "error",
      error: { type: "api_error", message: (error as Error).message },
    };
    const mappedRelay = mapProviderError(relay, "openai");
    expect(mappedRelay.code).toBe(ChatErrorCode.NetworkError);
    expect(mappedRelay.isRetryable).toBe(true);
    expect(mapProviderError({ ...relay, statusCode: 401 }, "openai").code).toBe(
      ChatErrorCode.Authentication,
    );
    expect(
      mapProviderError(
        {
          ...relay,
          error: { ...relay.error, type: OpenAIErrorTypes.RATE_LIMIT },
        },
        "openai",
      ).code,
    ).toBe(ChatErrorCode.RateLimit);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
