import Fastify from "fastify";
import dotenv from "dotenv";

dotenv.config();

const fastify = Fastify({
  logger: true,
});

// Google AI Studio API endpoint
const GOOGLE_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

// Handle all requests
fastify.all("/*", async (request, reply) => {
  const apiKey = process.env.GOOGLE_API_TOKEN;

  console.log(request.body);

  if (!apiKey) {
    return reply.code(500).send({ error: "GOOGLE_API_TOKEN not configured" });
  }

  // Build the target URL
  const url = new URL(request.url, GOOGLE_API_BASE);
  url.searchParams.set("key", apiKey);

  const targetUrl = `${GOOGLE_API_BASE}${url.pathname}?${url.searchParams}`;

  fastify.log.info(`Proxying to: ${targetUrl}`);

  try {
    // Forward the request to Google
    const response = await fetch(targetUrl, {
      method: request.method,
      headers: {
        ...request.headers,
        host: new URL(GOOGLE_API_BASE).host,
      },
      body:
        request.method !== "GET" && request.method !== "HEAD"
          ? JSON.stringify(request.body)
          : undefined,
    });

    console.log(response);

    // Set response headers
    reply.code(response.status);

    // Forward relevant headers
    const headersToForward = [
      "content-type",
      "content-length",
      "cache-control",
    ];
    headersToForward.forEach((header) => {
      const value = response.headers.get(header);
      if (value) {
        reply.header(header, value);
      }
    });

    // Handle streaming response
    if (response.headers.get("content-type")?.includes("text/event-stream")) {
      reply.type("text/event-stream");
      reply.header("cache-control", "no-cache");
      reply.header("connection", "keep-alive");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let totalTokenUsage = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });

        // Parse SSE data format
        if (chunk.startsWith("data: ")) {
          try {
            const jsonStr = chunk.substring(6); // Remove "data: " prefix
            const parsed = JSON.parse(jsonStr);
            if (parsed.usageMetadata) {
              console.log("Chunk Reported Usage Metadata:", parsed.usageMetadata);
              // Keep updating with latest usage metadata (usually comes in final chunk)
              totalTokenUsage = parsed.usageMetadata;
            }
          } catch (e) {
            // Not all chunks are valid JSON
          }
        }

        reply.raw.write(chunk);
      }

      reply.raw.end();

      // Log total token usage at the end
      if (totalTokenUsage) {
        console.log("\n=== TOTAL TOKEN USAGE ===");
        console.log("Prompt Tokens:", totalTokenUsage.promptTokenCount);
        console.log("Completion Tokens:", totalTokenUsage.candidatesTokenCount || 0);
        console.log("Total Tokens:", totalTokenUsage.totalTokenCount);
        console.log("========================\n");
      }
    } else {
      // Non-streaming response
      const data = await response.text();
      reply.send(data);
    }
  } catch (error) {
    fastify.log.error("Proxy error:", error);
    reply.code(500).send({ error: "Proxy failed", details: error.message });
  }
});

const start = async () => {
  try {
    const port = process.env.PORT || 8888;
    await fastify.listen({ port, host: "0.0.0.0" });
    console.log(`LLM proxy server running on http://localhost:${port}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
