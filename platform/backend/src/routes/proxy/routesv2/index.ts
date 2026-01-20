import type { FastifyPluginAsyncZod } from "fastify-type-provider-zod";
import anthropicProxyRoutesV2 from "./anthropic";
import cerebrasProxyRoutesV2 from "./cerebras";
import deepseekProxyRoutesV2 from "./deepseek";
import geminiProxyRoutesV2 from "./gemini";
import ollamaProxyRoutesV2 from "./ollama";
import openAiProxyRoutesV2 from "./openai";
import vllmProxyRoutesV2 from "./vllm";
import zhipuaiProxyRoutesV2 from "./zhipuai";

const unifiedProxyRoutesV2: FastifyPluginAsyncZod = async (fastify) => {
  await fastify.register(anthropicProxyRoutesV2);
  await fastify.register(cerebrasProxyRoutesV2);
  await fastify.register(geminiProxyRoutesV2);
  await fastify.register(ollamaProxyRoutesV2);
  await fastify.register(openAiProxyRoutesV2);
  await fastify.register(vllmProxyRoutesV2);
  await fastify.register(zhipuaiProxyRoutesV2);
  await fastify.register(deepseekProxyRoutesV2);
};

export default unifiedProxyRoutesV2;
