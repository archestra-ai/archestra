import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import config from "@/config";
import { afterEach, describe, expect, test } from "@/test";
import groqProxyRoutesV2 from "./groq";

describe("Groq V2 proxy", () => {
  afterEach(() => {
    config.benchmark.mockMode = false;
  });

  test("non-streaming response works in mock mode", async ({ makeAgent }) => {
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    await app.register(groqProxyRoutesV2);
    config.benchmark.mockMode = true;

    const agent = await makeAgent({ name: "Test Groq Agent" });

    const response = await app.inject({
      method: "POST",
      url: `/v1/groq/${agent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
      },
      payload: {
        model: "llama-3.1-70b",
        messages: [{ role: "user", content: "Hello!" }],
        stream: false,
      },
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.id).toBeDefined();
    expect(body.choices[0].message.content).toBeDefined();
  });

  test("streaming response has SSE format", async ({ makeAgent }) => {
    const app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    await app.register(groqProxyRoutesV2);
    config.benchmark.mockMode = true;

    const agent = await makeAgent({ name: "Test Groq Streaming Agent" });

    const response = await app.inject({
      method: "POST",
      url: `/v1/groq/${agent.id}/chat/completions`,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
      },
      payload: {
        model: "llama-3.1-70b",
        messages: [{ role: "user", content: "Hello!" }],
        stream: true,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("data: ");
    expect(response.body).toContain("data: [DONE]");
  });
});
