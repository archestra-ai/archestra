/** Keep SDK response buffering within the same bound as the proxy request. */
export function boundedMediaFetch(
  baseFetch: typeof fetch,
  maximum: number,
): typeof fetch {
  return async (input, init) => {
    const response = await baseFetch(input, init);
    if (!response.body) return response;
    if (Number(response.headers.get("content-length")) > maximum) {
      await response.body.cancel();
      return oversizedResponse();
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maximum) {
          await reader.cancel();
          return oversizedResponse();
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const headers = new Headers(response.headers);
    headers.delete("content-encoding");
    headers.delete("content-length");
    return new Response(Buffer.concat(chunks), {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  };
}

function oversizedResponse() {
  // An HTTP error prevents SDK/handler connection retries from repeating a paid operation.
  return Response.json(
    {
      error: {
        message: "Provider media response exceeds the proxy body limit",
        type: "invalid_response_error",
      },
    },
    { status: 502 },
  );
}
