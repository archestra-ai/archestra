// biome-ignore-all lint/suspicious/noExplicitAny: experiments

import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { OpenAI } from "openai";

interface ChatCompletionRequest {
  model: string;
  messages: Array<{
    role: "system" | "user" | "assistant";
    content: string;
  }>;
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
}

const fastify = Fastify({
  logger: {
    transport: {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "HH:MM:ss Z",
        ignore: "pid,hostname",
      },
    },
  },
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY || "your-api-key-here",
});

// Health check route
fastify.get("/", async function handler(request, reply) {
  return { status: "OpenAI Proxy Server", version: "1.0.0" };
});

// Chat completions proxy endpoint
fastify.post<{
  Body: ChatCompletionRequest;
}>(
  "/v1/chat/completions",
  async function handler(
    request: FastifyRequest<{ Body: ChatCompletionRequest }>,
    reply: FastifyReply,
  ) {
    const { method, url, headers } = request;
    const payload = request.body;

    // Log the incoming request
    fastify.log.info(
      {
        type: "request",
        method,
        url,
        path: "/v1/chat/completions",
        headers: {
          "content-type": headers["content-type"],
          authorization: headers.authorization ? "[REDACTED]" : undefined,
        },
        payload,
      },
      "Incoming OpenAI API request",
    );

    try {
      // Check if this is a streaming request
      if (payload.stream) {
        // Handle streaming response - explicitly cast the payload to include stream: true
        const streamPayload = { ...payload, stream: true as const };
        const stream = await openai.chat.completions.create(streamPayload);

        // Log the streaming request
        fastify.log.info(
          {
            type: "response",
            path: "/v1/chat/completions",
            status: 200,
            streaming: true,
          },
          "OpenAI streaming response started",
        );

        // Set appropriate headers for streaming
        reply.header("Content-Type", "text/plain; charset=utf-8");
        reply.header("Cache-Control", "no-cache");
        reply.header("Connection", "keep-alive");

        // Stream the response back to the client
        for await (const chunk of stream) {
          const data = `data: ${JSON.stringify(chunk)}\n\n`;
          reply.raw.write(data);
        }

        // End the stream
        reply.raw.write("data: [DONE]\n\n");
        reply.raw.end();
        return;
      } else {
        // Handle non-streaming response - explicitly cast the payload to exclude stream
        const nonStreamPayload = { ...payload, stream: false as const };
        const response = await openai.chat.completions.create(nonStreamPayload);

        // Log the response
        fastify.log.info(
          {
            type: "response",
            path: "/v1/chat/completions",
            status: 200,
            response,
          },
          "OpenAI API response",
        );

        return response;
      }
    } catch (error) {
      // Log the error
      fastify.log.error(
        {
          type: "error",
          path: "/v1/chat/completions",
          error: error instanceof Error ? error.message : "Unknown error",
          payload,
        },
        "OpenAI API error",
      );

      const statusCode =
        error instanceof Error && "status" in error
          ? (error as any).status
          : 500;
      const errorMessage =
        error instanceof Error ? error.message : "Internal server error";

      reply.status(statusCode).send({
        error: {
          message: errorMessage,
          type: "api_error",
        },
      });
    }
  },
);

// Responses endpoint proxy (newer OpenAI API)
fastify.post<{
  Body: any;
}>(
  "/v1/responses",
  async function handler(
    request: FastifyRequest<{ Body: any }>,
    reply: FastifyReply,
  ) {
    const { method, url, headers } = request;
    const payload = request.body as any;

    // Log the incoming request
    fastify.log.info(
      {
        type: "request",
        method,
        url,
        path: "/v1/responses",
        headers: {
          "content-type": headers["content-type"],
          authorization: headers.authorization ? "[REDACTED]" : undefined,
        },
        payloadPreview: {
          model: payload.model,
          inputLength: payload.input?.length,
          stream: payload.stream,
          toolCount: payload.tools?.length,
        },
      },
      "Incoming OpenAI responses request",
    );

    try {
      // Forward directly to OpenAI's responses endpoint
      const response = await fetch("https://api.openai.com/v1/responses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization:
            headers.authorization || `Bearer ${process.env.OPENAI_API_KEY}`,
          "User-Agent": headers["user-agent"] || "OpenAI-Proxy/1.0.0",
        },
        body: JSON.stringify(payload),
      });

      // Log the response status
      fastify.log.info(
        {
          type: "response",
          path: "/v1/responses",
          status: response.status,
          streaming: payload.stream,
        },
        "OpenAI responses API response",
      );

      // Handle streaming response
      if (payload.stream && response.body) {
        reply.header(
          "Content-Type",
          response.headers.get("content-type") || "text/plain",
        );
        reply.header("Cache-Control", "no-cache");
        reply.header("Connection", "keep-alive");

        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            const chunk = decoder.decode(value, { stream: true });
            reply.raw.write(chunk);
          }
        } finally {
          reader.releaseLock();
        }

        reply.raw.end();
        return;
      } else {
        // Handle non-streaming response
        const responseData = await response.json();

        if (!response.ok) {
          reply.status(response.status).send(responseData);
          return;
        }

        return responseData;
      }
    } catch (error) {
      // Log the error
      fastify.log.error(
        {
          type: "error",
          path: "/v1/responses",
          error: error instanceof Error ? error.message : "Unknown error",
          payloadPreview: {
            model: payload.model,
            inputLength: payload.input?.length,
          },
        },
        "OpenAI responses API error",
      );

      const statusCode = 500;
      const errorMessage =
        error instanceof Error ? error.message : "Internal server error";

      reply.status(statusCode).send({
        error: {
          message: errorMessage,
          type: "api_error",
        },
      });
    }
  },
);

// Models endpoint proxy
fastify.get(
  "/v1/models",
  async function handler(request: FastifyRequest, reply: FastifyReply) {
    const { method, url } = request;

    // Log the incoming request
    fastify.log.info(
      {
        type: "request",
        method,
        url,
        path: "/v1/models",
      },
      "Incoming OpenAI models request",
    );

    try {
      const response = await openai.models.list();

      // Log the response
      fastify.log.info(
        {
          type: "response",
          path: "/v1/models",
          status: 200,
          modelCount: response.data.length,
        },
        "OpenAI models response",
      );

      return response;
    } catch (error) {
      // Log the error
      fastify.log.error(
        {
          type: "error",
          path: "/v1/models",
          error: error instanceof Error ? error.message : "Unknown error",
        },
        "OpenAI models error",
      );

      const statusCode =
        error instanceof Error && "status" in error
          ? (error as any).status
          : 500;
      const errorMessage =
        error instanceof Error ? error.message : "Internal server error";

      reply.status(statusCode).send({
        error: {
          message: errorMessage,
          type: "api_error",
        },
      });
    }
  },
);

// Catch-all route to log unhandled requests
fastify.all("/*", async (request, reply) => {
  fastify.log.warn(
    {
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: request.body,
    },
    "Unhandled request - adding this endpoint might be needed",
  );

  reply.status(404).send({
    error: {
      message: `Endpoint ${request.method} ${request.url} not implemented in proxy`,
      type: "not_found",
    },
  });
});

// Run the server!
const start = async () => {
  try {
    await fastify.listen({ port: 9000, host: "0.0.0.0" });
    fastify.log.info("OpenAI Proxy Server started on port 9000");
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
