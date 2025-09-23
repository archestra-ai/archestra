import Fastify from "fastify";
import dotenv from "dotenv";

dotenv.config();

const fastify = Fastify({
  logger: true,
});

// Google AI Studio API endpoint
const GOOGLE_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

// Only handle the specific Gemini 2.5 Flash streaming endpoint
fastify.post(
  "/models/gemini-2.5-flash:streamGenerateContent",
  async (request, reply) => {
    const apiKey = process.env.GOOGLE_API_TOKEN;

    console.log("Request body", request.body);

    if (!apiKey) {
      return reply.code(500).send({ error: "GOOGLE_API_TOKEN not configured" });
    }

    // Build the target URL with the API key
    const targetUrl = `${GOOGLE_API_BASE}/models/gemini-2.5-flash:streamGenerateContent?alt=sse&key=${apiKey}`;

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

      console.log("Response: ", response);

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

      // Only support streaming responses
      if (!response.headers.get("content-type")?.includes("text/event-stream")) {
        console.log("Non-streaming response received, but only streaming is supported");
        return reply.code(400).send({
          error: "Only streaming responses are supported",
          details: "The proxy only handles SSE streaming responses"
        });
      }

      // Handle streaming response
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

        // Parse SSE data format and filter response
        if (chunk.startsWith("data: ")) {
          try {
            const jsonStr = chunk.substring(6); // Remove "data: " prefix
            const parsed = JSON.parse(jsonStr);

            // Filter the response to only include safe fields
            const filteredResponse = {};

            if (parsed.candidates) {
              filteredResponse.candidates = parsed.candidates.map(candidate => ({
                content: candidate.content,
                finishReason: candidate.finishReason,
                index: candidate.index
              }));
            }

            if (parsed.usageMetadata) {
              filteredResponse.usageMetadata = parsed.usageMetadata;
              totalTokenUsage = parsed.usageMetadata;
              console.log(
                "Chunk Reported Usage Metadata:",
                parsed.usageMetadata,
              );
            }

            if (parsed.modelVersion) {
              filteredResponse.modelVersion = parsed.modelVersion;
            }

            if (parsed.responseId) {
              filteredResponse.responseId = parsed.responseId;
            }

            // Send filtered chunk
            const filteredChunk = `data: ${JSON.stringify(filteredResponse)}\n\n`;
            reply.raw.write(filteredChunk);
            console.log("Filtered Chunk: ", filteredChunk);
          } catch (e) {
            // Not all chunks are valid JSON, pass through as-is
            reply.raw.write(chunk);
            console.log("Chunk: ", chunk);
          }
        } else {
          // Non-data chunks (like newlines), pass through
          reply.raw.write(chunk);
        }
      }

      reply.raw.end();

      // Log total token usage at the end
      if (totalTokenUsage) {
        console.log("\n=== TOTAL TOKEN USAGE ===");
        console.log("Prompt Tokens:", totalTokenUsage.promptTokenCount);
        console.log(
          "Completion Tokens:",
          totalTokenUsage.candidatesTokenCount || 0,
        );
        console.log("Total Tokens:", totalTokenUsage.totalTokenCount);
        console.log("========================\n");
      }
    } catch (error) {
      fastify.log.error("Proxy error:", error);
      reply.code(500).send({ error: "Proxy failed", details: error.message });
    }
  },
);

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
