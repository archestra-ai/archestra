import { writeFile } from "node:fs/promises";
import type OpenAI from "openai";
import config from "@/config";
import { createFastifyInstance } from "@/fastify-instance";
import { InteractionModel, VirtualApiKeyModel } from "@/models";
import { expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import azureRoutes from "./azure";

setupTestCacheManager();

// Explicit opt-in: credentials stay in memory and the isolated fixture database.
// A deployment must already exist; this test never creates Azure resources.
test.skipIf(
  !process.env.ARCHESTRA_AUDIO_LIVE_BASE_URL ||
    !process.env.ARCHESTRA_AUDIO_LIVE_KEY,
)(
  "bounded live Azure standard audio through the local governed routes",
  async ({
    makeAgent,
    makeUser,
    makeMember,
    makeSecret,
    makeLlmProviderApiKey,
  }) => {
    const agent = await makeAgent({ isDefault: true, agentType: "llm_proxy" });
    const user = await makeUser();
    await makeMember(user.id, agent.organizationId);
    const secret = await makeSecret({
      secret: { apiKey: process.env.ARCHESTRA_AUDIO_LIVE_KEY },
    });
    const providerKey = await makeLlmProviderApiKey(
      agent.organizationId,
      secret.id,
      {
        provider: "azure",
        baseUrl: process.env.ARCHESTRA_AUDIO_LIVE_BASE_URL,
      },
    );
    const { value: token } = await VirtualApiKeyModel.create({
      organizationId: agent.organizationId,
      name: "Bounded live audio fixture",
      authorId: user.id,
      scope: "personal",
      providerApiKeys: [
        { provider: "azure", providerApiKeyId: providerKey.id },
      ],
    });
    config.llmProxy.plugins = [];
    config.llmProxy.upstreamTimeoutMs = 15_000;
    const app = createFastifyInstance();
    await app.register(azureRoutes);
    const results: Array<Record<string, unknown>> = [];
    try {
      const origin = await app.listen({ port: 0, host: "127.0.0.1" });
      const SDK = (await import(process.env.ARCHESTRA_AUDIO_JS_SDK ?? "openai"))
        .default as typeof OpenAI;
      const client = new SDK({
        baseURL: `${origin}/v1/azure`,
        apiKey: token,
        maxRetries: 0,
        timeout: 20_000,
      });
      // 10 ms of synthetic silence, with a valid PCM WAV header.
      const wav = Buffer.alloc(44 + 320);
      wav.write("RIFF");
      wav.writeUInt32LE(wav.length - 8, 4);
      wav.write("WAVEfmt ", 8);
      wav.writeUInt32LE(16, 16);
      wav.writeUInt16LE(1, 20);
      wav.writeUInt16LE(1, 22);
      wav.writeUInt32LE(16_000, 24);
      wav.writeUInt32LE(32_000, 28);
      wav.writeUInt16LE(2, 32);
      wav.writeUInt16LE(16, 34);
      wav.write("data", 36);
      wav.writeUInt32LE(320, 40);
      for (const operation of [
        "speech",
        "transcriptions",
        "translations",
      ] as const) {
        let status = 200;
        let bytes: number | undefined;
        const model = process.env.ARCHESTRA_AUDIO_LIVE_MODEL;
        if (!model) throw new Error("An existing deployment name is required");
        try {
          if (operation === "speech") {
            const response = await client.audio.speech.create({
              model,
              input: "Hello.",
              voice: "alloy",
              response_format: "wav",
            });
            bytes = (await response.arrayBuffer()).byteLength;
            expect(bytes).toBeGreaterThan(0);
          } else {
            const response = await client.audio[operation].create({
              model,
              file: new File([wav], "synthetic-silence.wav", {
                type: "audio/wav",
              }),
            });
            expect(typeof response.text).toBe("string");
          }
        } catch (error) {
          if (!(error instanceof SDK.APIError)) throw error;
          status = error.status ?? 0;
        }
        results.push({
          operation,
          status,
          ...(bytes === undefined ? {} : { bytes }),
        });
      }
      const rows = await InteractionModel.getAllInteractionsForProfile(
        agent.id,
      );
      expect(rows).toHaveLength(3);
      expect(rows.every((row) => row.cost === null)).toBe(true);
      if (process.env.ARCHESTRA_AUDIO_LIVE_EVIDENCE)
        await writeFile(
          process.env.ARCHESTRA_AUDIO_LIVE_EVIDENCE,
          JSON.stringify(
            {
              evidence: "live-provider-through-isolated-local-routes",
              results,
              interactionCount: rows.length,
              costsUnavailable: true,
            },
            null,
            2,
          ),
        );
      const expectedStatuses = JSON.parse(
        process.env.ARCHESTRA_AUDIO_LIVE_EXPECT_STATUSES ?? "{}",
      ) as Record<string, number>;
      for (const result of results)
        expect(result.status).toBe(
          expectedStatuses[String(result.operation)] ?? 200,
        );
    } finally {
      await app.close();
    }
  },
  70_000,
);
