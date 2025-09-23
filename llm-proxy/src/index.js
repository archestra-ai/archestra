import Fastify from "fastify";
import dotenv from "dotenv";

// Load environment variables from .env file
dotenv.config();

// Initialize Fastify server with logging enabled
const fastify = Fastify({
  logger: true,
});

// Google AI Studio API base URL for Gemini models
const GOOGLE_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

/**
 * Proxy endpoint for Gemini 2.5 Flash streaming API
 * This endpoint:
 * 1. Receives requests from the Archestra app
 * 2. Adds the Google API key from environment variables
 * 3. Forwards the request to Google's Gemini API
 * 4. Filters the response to remove sensitive information
 * 5. Streams the filtered response back to the client
 */
fastify.post(
  "/models/gemini-2.5-flash:streamGenerateContent",
  async (request, reply) => {
    // Get API key from environment variable
    const apiKey = process.env.GOOGLE_API_TOKEN;

    console.log("Request body", request.body);

    // Validate that API key is configured
    if (!apiKey) {
      return reply.code(500).send({ error: "GOOGLE_API_TOKEN not configured" });
    }

    // Construct the full Google API URL with API key
    // alt=sse enables Server-Sent Events streaming format
    const targetUrl = `${GOOGLE_API_BASE}/models/gemini-2.5-flash:streamGenerateContent?alt=sse&key=${apiKey}`;

    fastify.log.info(`Proxying to: ${targetUrl}`);

    try {
      // Forward the request to Google's API
      const response = await fetch(targetUrl, {
        method: request.method,
        headers: {
          ...request.headers,
          host: new URL(GOOGLE_API_BASE).host, // Override host header
        },
        body:
          request.method !== "GET" && request.method !== "HEAD"
            ? JSON.stringify(request.body)
            : undefined,
      });

      console.log("Response: ", response);

      // Pass through the response status code
      reply.code(response.status);

      // Only forward specific headers to avoid leaking sensitive information
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

      // Verify that the response is a streaming response (SSE)
      // We only support streaming to ensure consistent handling
      if (!response.headers.get("content-type")?.includes("text/event-stream")) {
        console.log("Non-streaming response received, but only streaming is supported");
        return reply.code(400).send({
          error: "Only streaming responses are supported",
          details: "The proxy only handles SSE streaming responses"
        });
      }

      // Set up SSE response headers for streaming
      reply.type("text/event-stream");
      reply.header("cache-control", "no-cache");
      reply.header("connection", "keep-alive");

      // Initialize streaming reader and decoder
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let totalTokenUsage = null;

      // Process the stream chunk by chunk
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });

        // SSE format: each data chunk starts with "data: "
        if (chunk.startsWith("data: ")) {
          try {
            // Extract and parse the JSON payload
            const jsonStr = chunk.substring(6); // Remove "data: " prefix
            const parsed = JSON.parse(jsonStr);

            // Create filtered response with only safe fields
            // This prevents leaking any sensitive information from the API
            const filteredResponse = {};

            // Include candidate responses (the actual generated content)
            if (parsed.candidates) {
              filteredResponse.candidates = parsed.candidates.map(candidate => ({
                content: candidate.content,         // The generated text/content
                finishReason: candidate.finishReason, // Why generation stopped
                index: candidate.index               // Candidate index
              }));
            }

            // Include token usage statistics
            if (parsed.usageMetadata) {
              filteredResponse.usageMetadata = parsed.usageMetadata;
              totalTokenUsage = parsed.usageMetadata; // Store for final logging
              console.log(
                "Chunk Reported Usage Metadata:",
                parsed.usageMetadata,
              );
            }

            // Include model version information
            if (parsed.modelVersion) {
              filteredResponse.modelVersion = parsed.modelVersion;
            }

            // Include response ID for tracking
            if (parsed.responseId) {
              filteredResponse.responseId = parsed.responseId;
            }

            // Reconstruct the SSE data chunk with filtered content
            const filteredChunk = `data: ${JSON.stringify(filteredResponse)}\n\n`;
            reply.raw.write(filteredChunk);
            console.log("Filtered Chunk: ", filteredChunk);
          } catch (e) {
            // If parsing fails, pass through the original chunk
            // This handles special SSE messages like [DONE]
            reply.raw.write(chunk);
            console.log("Chunk: ", chunk);
          }
        } else {
          // Non-data chunks (like newlines between events), pass through as-is
          reply.raw.write(chunk);
        }
      }

      // End the streaming response
      reply.raw.end();

      // Log final token usage statistics
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
      // Handle any errors that occur during proxying
      fastify.log.error("Proxy error:", error);
      reply.code(500).send({ error: "Proxy failed", details: error.message });
    }
  },
);

/**
 * Start the proxy server
 * Listens on port 8888 by default, or PORT environment variable if set
 * Binds to 0.0.0.0 to accept connections from any network interface
 */
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

// Start the server
start();
