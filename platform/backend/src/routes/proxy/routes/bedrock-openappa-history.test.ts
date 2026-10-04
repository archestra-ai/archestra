/**
 * Bedrock Converse proxy routes — OpenAPPA calls left in a client's history.
 *
 * The proxy never restores a notice on the Converse wire, so the history a
 * client sends back keeps what an OpenAPPA session handed it: the notice call
 * that took a blocked call's place, with the proxy's record and the signed
 * remedy offers, and the model's remedy call, with the receipt and the offer
 * JWS the proxy stamped on it. With no OpenAPPA plugin registered no session
 * path runs, and the provider still gets those calls back holding only what
 * the model saw and wrote.
 */

import { vi } from "vitest";
import config from "@/config";
import { createFastifyInstance } from "@/fastify-instance";
import { buildNoticeArguments, type RemedyExecution } from "@/openappa/notice";
import { signOfferClaims, unsignedOfferClaims } from "@/openappa/offer-claims";
import { getLlmProxyPluginRegistry } from "@/proxy/plugins/registry";
import { afterEach, describe, expect, test } from "@/test";
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

  test("forwards a Converse history without the notice's signed offers or the remedy call's receipt", async ({
    makeAgent,
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
    const offer = signOfferClaims(
      unsignedOfferClaims({
        organizationId: agent.organizationId,
        sessionId: "virtual-key:converse-client|weather-session",
        offerId: OFFER_ID,
        tool: "get_weather",
        spelling: "get_weather",
      }),
      config.openappa.offerSigningSecret,
    );
    const remedy = {
      offer_id: OFFER_ID,
      plan: "Allow this get_weather call once.",
    };

    const response = await app.inject({
      method: "POST",
      url: `/v1/bedrock/${agent.id}/converse`,
      headers: HEADERS,
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
                  input: buildNoticeArguments({
                    id: "tooluse_weather",
                    tool: "get_weather",
                    arguments: { location: "San Francisco" },
                    result: RULING,
                    offers: [offer],
                  }),
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
          name: NOTICE_TOOL,
          input: {
            tool: "get_weather",
            arguments: { location: "San Francisco" },
            ruling: RULING,
          },
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
