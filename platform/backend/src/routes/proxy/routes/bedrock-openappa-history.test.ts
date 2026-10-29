/**
 * Bedrock Converse proxy routes — OpenAPPA calls left in a client's history.
 *
 * The history a client sends back keeps what an OpenAPPA session handed it:
 * the notice call that took a blocked call's place, with the proxy's record
 * and leftover offer fields, and the model's remedy call, with the receipt and
 * the legacy offer fields the proxy used to stamp. With no OpenAPPA plugin
 * registered no session path runs, yet the provider still gets the blocked
 * call back as the model wrote it, and the remedy call holding only what the
 * model wrote.
 */

import { vi } from "vitest";
import config from "@/config";
import { createFastifyInstance } from "@/fastify-instance";
import { buildNoticeArguments, type RemedyExecution } from "@/openappa/notice";
import { getLlmProxyPluginRegistry } from "@/proxy/plugins/registry";
import { afterEach, describe, expect, test } from "@/test";
import { makePassthroughCredential } from "@/test/llm-proxy-credentials";
import { bedrockAdapterFactory } from "../adapters/bedrock";
import bedrockProxyRoutes from "./bedrock";

const MODEL_ID = "anthropic.claude-haiku-4-5-20251001-v1:0";
const NOTICE_TOOL = "archestra__get_remedy_plans";
const CONTROL_TOOL = "archestra__execute_remedy_plan";
const OFFER_ID = "offer-weather-sf";
const RULING = "[appa] Blocked: get_weather needs an approved remedy.";

const HEADERS = {
  "content-type": "application/json",
  authorization: "Bearer test-key",
  "user-agent": "test-client",
};

type ConverseInput = { messages: { content: unknown[] }[] };

function toolSpec(name: string) {
  return { toolSpec: { name, inputSchema: { json: { type: "object" } } } };
}

describe("Bedrock Converse proxy — OpenAPPA history", () => {
  afterEach(() => vi.restoreAllMocks());

  test("forwards a Converse history with the blocked call restored and no remedy receipt", async ({
    makeAgent,
    makeMember,
    makeUser,
  }) => {
    // The registry is process-wide: no session path may touch this history.
    expect(getLlmProxyPluginRegistry().hasPlugins()).toBe(false);
    config.openappa.offerSigningSecret = "test-offer-signing-secret-32chars";
    const captured: ConverseInput[] = [];
    vi.spyOn(bedrockAdapterFactory, "createClient").mockImplementation(
      () =>
        ({
          converse: async (_modelId: string, request: ConverseInput) => {
            captured.push(request);
            return {
              output: {
                message: {
                  role: "assistant",
                  content: [{ text: "It is sunny in San Francisco." }],
                },
              },
              stopReason: "end_turn",
              usage: { inputTokens: 40, outputTokens: 8, totalTokens: 48 },
            };
          },
        }) as never,
    );

    const app = createFastifyInstance();
    await app.register(bedrockProxyRoutes);
    const agent = await makeAgent({ name: "bedrock-openappa-history-agent" });
    const owner = await makeUser();
    await makeMember(owner.id, agent.organizationId);
    const passthroughKey = await makePassthroughCredential({
      organizationId: agent.organizationId,
      ownerId: owner.id,
    });
    // Leftover offer material from persisted history. Not minted, and not a route.
    const offer = {
      protected: "eyJhbGciOiJIUzI1NiJ9",
      payload: JSON.stringify({
        session_id: "historical-offer-session",
        offer_id: OFFER_ID,
      }),
      signature: "historical-offer",
    };
    const remedy = {
      offer_id: OFFER_ID,
      plan: "Allow this get_weather call once.",
    };

    const response = await app.inject({
      method: "POST",
      url: `/v1/bedrock/${agent.id}/converse`,
      headers: { ...HEADERS, "x-archestra-virtual-key": passthroughKey },
      payload: {
        modelId: MODEL_ID,
        // Converse requires toolConfig whenever the history holds tool blocks.
        toolConfig: {
          tools: [
            toolSpec("get_weather"),
            toolSpec(NOTICE_TOOL),
            toolSpec(CONTROL_TOOL),
          ],
        },
        messages: [
          {
            role: "user",
            content: [{ text: "What's the weather in San Francisco?" }],
          },
          {
            role: "assistant",
            content: [
              {
                toolUse: {
                  toolUseId: "tooluse_weather",
                  name: NOTICE_TOOL,
                  input: {
                    ...buildNoticeArguments({
                      id: "tooluse_weather",
                      tool: "get_weather",
                      arguments: { location: "San Francisco" },
                      result: RULING,
                    }),
                    offers: [offer],
                  },
                },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                toolResult: {
                  toolUseId: "tooluse_weather",
                  content: [{ text: RULING }],
                },
              },
            ],
          },
          {
            role: "assistant",
            content: [
              {
                toolUse: {
                  toolUseId: "tooluse_remedy",
                  name: CONTROL_TOOL,
                  input: {
                    ...remedy,
                    execution: {
                      v: 1,
                      kind: "appa_remedy",
                      call_id: "tooluse_remedy",
                      tool_name: CONTROL_TOOL,
                      original_arguments: JSON.stringify(remedy),
                    } satisfies RemedyExecution,
                    ...offer,
                  },
                },
              },
            ],
          },
          {
            role: "user",
            content: [
              {
                toolResult: {
                  toolUseId: "tooluse_remedy",
                  content: [{ text: "Remedy applied." }],
                },
              },
            ],
          },
        ],
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(captured).toHaveLength(1);
    const { messages } = captured[0];
    expect(messages[1].content).toEqual([
      {
        toolUse: {
          toolUseId: "tooluse_weather",
          name: "get_weather",
          input: { location: "San Francisco" },
        },
      },
    ]);
    expect(messages[2].content).toEqual([
      {
        toolResult: {
          toolUseId: "tooluse_weather",
          content: [{ text: RULING }],
          status: "error",
        },
      },
    ]);
    expect(messages[3].content).toEqual([
      {
        toolUse: {
          toolUseId: "tooluse_remedy",
          name: CONTROL_TOOL,
          input: remedy,
        },
      },
    ]);
    expect(JSON.stringify(captured[0])).not.toContain('"signature"');
  });
});
