import Fastify from "fastify";
import dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";

// Load environment variables from .env file
dotenv.config();

// Initialize Fastify server with logging enabled
const fastify = Fastify({
  logger: true,
});

// Initialize Google Generative AI with API key from environment
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_TOKEN || "");

/**
 * Proxy endpoint for Gemini 2.5 Flash streaming API
 * This endpoint:
 * 1. Receives requests from the Archestra app
 * 2. Uses the Google Generative AI SDK to make secure API calls
 * 3. Streams the response back to the client
 * 4. Filters sensitive information from the response
 */
fastify.post(
  "/models/gemini-2.5-flash:streamGenerateContent",
  async (request, reply) => {
    // Validate that API key is configured
    if (!process.env.GOOGLE_API_TOKEN) {
      return reply.code(500).send({ error: "GOOGLE_API_TOKEN not configured" });
    }

    console.log("Request body", request.body);

    try {
      // Initialize the Gemini 2.5 Flash model
      const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

      // Extract request parameters from the body
      const { contents, generationConfig, tools, toolConfig, systemInstruction } = request.body;

      // Prepare the request configuration
      const requestConfig = {
        contents,
        generationConfig,
      };

      // Add optional parameters if they exist
      if (tools) {
        requestConfig.tools = tools;
      }
      if (toolConfig) {
        requestConfig.toolConfig = toolConfig;
      }
      if (systemInstruction) {
        requestConfig.systemInstruction = systemInstruction;
      }

      // Set up SSE response headers for streaming
      reply.type("text/event-stream");
      reply.header("cache-control", "no-cache");
      reply.header("connection", "keep-alive");

      console.log("Starting stream generation with config:", requestConfig);

      // Generate streaming content
      const result = await model.generateContentStream(requestConfig);

      let totalTokenUsage = null;
      let responseId = null;
      let modelVersion = null;

      // Process the stream
      for await (const chunk of result.stream) {
        // Get the chunk data
        const chunkData = chunk;

        // Build filtered response matching the expected format
        const filteredResponse = {};

        // Add candidates if present
        if (chunkData.candidates) {
          filteredResponse.candidates = chunkData.candidates.map(candidate => ({
            content: candidate.content,
            finishReason: candidate.finishReason,
            index: candidate.index || 0,
          }));
        }

        // Add usage metadata if present
        if (chunkData.usageMetadata) {
          filteredResponse.usageMetadata = chunkData.usageMetadata;
          totalTokenUsage = chunkData.usageMetadata;
        }

        // Add other metadata
        if (chunkData.modelVersion) {
          filteredResponse.modelVersion = chunkData.modelVersion;
          modelVersion = chunkData.modelVersion;
        }

        if (chunkData.responseId) {
          filteredResponse.responseId = chunkData.responseId;
          responseId = chunkData.responseId;
        }

        // Send the chunk in SSE format
        const sseChunk = `data: ${JSON.stringify(filteredResponse)}\n\n`;
        reply.raw.write(sseChunk);

        console.log("Sent chunk:", sseChunk);
      }

      // Get the final response for complete metadata
      const finalResponse = await result.response;

      // Send final chunk with complete metadata
      const finalChunk = {
        candidates: finalResponse.candidates?.map((candidate, index) => ({
          content: candidate.content,
          finishReason: candidate.finishReason,
          index: index,
        })),
        usageMetadata: finalResponse.usageMetadata,
        modelVersion: modelVersion || "gemini-2.5-flash",
        responseId: responseId,
      };

      const sseFinalChunk = `data: ${JSON.stringify(finalChunk)}\n\n`;
      reply.raw.write(sseFinalChunk);

      // Send the [DONE] marker
      reply.raw.write("data: [DONE]\n\n");

      // End the streaming response
      reply.raw.end();

      // Log final token usage statistics
      if (finalResponse.usageMetadata) {
        console.log("\n=== TOTAL TOKEN USAGE ===");
        console.log("Prompt Tokens:", finalResponse.usageMetadata.promptTokenCount);
        console.log(
          "Completion Tokens:",
          finalResponse.usageMetadata.candidatesTokenCount || 0,
        );
        console.log("Total Tokens:", finalResponse.usageMetadata.totalTokenCount);
        console.log("========================\n");
      }
    } catch (error) {
      // Handle any errors that occur during generation
      fastify.log.error("Generation error:", error);

      // Check if we've already started streaming
      if (!reply.sent) {
        reply.code(500).send({
          error: "Generation failed",
          details: error.message
        });
      } else {
        // If streaming has started, send error in SSE format
        const errorChunk = `data: ${JSON.stringify({
          error: true,
          message: error.message
        })}\n\n`;
        reply.raw.write(errorChunk);
        reply.raw.end();
      }
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
    console.log(`Using Google Generative AI SDK for secure API calls`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

// Start the server
start();