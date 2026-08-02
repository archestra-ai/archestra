/**
 * The Responses adapters end a turn with `response.completed`, and that
 * envelope echoes the turn's `function_call` items. A client keeps the LAST
 * completed frame it sees — the SDK's accumulator overwrites its snapshot on
 * each one and `finalResponse()` returns the survivor — so the order the proxy
 * writes those frames in decides what the turn reconstructs to.
 *
 * The refusal path synthesises its own `response.completed` carrying the
 * refusal text alone. It has to be the last one, or the client rebuilds the
 * turn as the very call the gate refused and dispatches it.
 */

import { CHAT_API_KEY_ID_HEADER } from "@archestra/shared";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { afterEach, beforeEach, vi } from "vitest";
import type { PolicyBlockResult } from "@/guardrails/tool-invocation";
import { describe, expect, test } from "@/test";

const mockEvaluatePolicies = vi.fn<(...args: unknown[]) => Promise<unknown>>();
vi.mock("@/guardrails/tool-invocation", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/guardrails/tool-invocation")>();
  return {
    ...original,
    evaluatePolicies: (...args: unknown[]) => mockEvaluatePolicies(...args),
  };
});

vi.mock("@/guardrails/trusted-data", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/guardrails/trusted-data")>();
  return {
    ...original,
    evaluateIfContextIsTrusted: async () => ({
      toolResultUpdates: {},
      contextIsTrusted: true,
      usedDualLlm: false,
      dualLlmAnalyses: [],
      unsafeContextBoundary: undefined,
    }),
  };
});

import { openAiResponsesAdapterFactory } from "./adapters/openai-responses";
import openAiProxyRoutes from "./routes/openai";

const CALL_ID = "call_refused_1";

/** A turn whose only output is a function call, ending with `response.completed`. */
function responsesStreamChunks() {
  const functionCall = {
    type: "function_call",
    id: "fc_1",
    call_id: CALL_ID,
    name: "get_weather",
    arguments: '{"location":"SF"}',
    status: "completed",
  };
  return [
    {
      type: "response.output_item.added",
      output_index: 0,
      sequence_number: 1,
      item: functionCall,
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      sequence_number: 2,
      item: functionCall,
    },
    {
      type: "response.completed",
      sequence_number: 3,
      response: {
        id: "resp_1",
        object: "response",
        status: "completed",
        model: "gpt-5.6",
        output: [functionCall],
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    },
  ];
}

describe("Responses refusal terminal ordering", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.spyOn(openAiResponsesAdapterFactory, "createClient").mockImplementation(
      () =>
        ({
          responses: {
            create: async () => ({
              async *[Symbol.asyncIterator]() {
                for (const chunk of responsesStreamChunks()) {
                  yield chunk;
                }
              },
            }),
          },
        }) as never,
    );

    app = Fastify().withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(openAiProxyRoutes);
  });

  afterEach(async () => {
    await app?.close();
    vi.restoreAllMocks();
  });

  test("the turn a client rebuilds after a refusal carries no tool call", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent();
    mockEvaluatePolicies.mockResolvedValue({
      refusalMessage: "Tool get_weather is not enabled here",
      contentMessage: "Tool get_weather is not enabled here",
      reason: "Tool invocation blocked: disabled for conversation",
      blockedToolName: "get_weather",
      toolInput: {},
      allToolCallNames: ["get_weather"],
    } satisfies PolicyBlockResult);

    const response = await app.inject({
      method: "POST",
      url: `/v1/openai/${agent.id}/responses`,
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key",
        [CHAT_API_KEY_ID_HEADER]: "",
      },
      payload: {
        model: "gpt-5.6",
        input: [{ role: "user", content: "weather?" }],
        stream: true,
      },
    });

    expect(response.statusCode).toBe(200);

    // Reconstruct the way a Responses client does: last `response.completed`
    // wins, and that snapshot is what the agentic loop dispatches from.
    const completed = response.body
      .split("\n")
      .filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
      .map((line) => {
        try {
          return JSON.parse(line.slice("data: ".length));
        } catch {
          return null;
        }
      })
      .filter((event) => event?.type === "response.completed");

    expect(completed.length).toBeGreaterThan(0);
    const finalOutput = completed[completed.length - 1].response?.output ?? [];
    expect(
      finalOutput.some(
        (item: { type?: string }) => item?.type === "function_call",
      ),
    ).toBe(false);
    expect(JSON.stringify(finalOutput)).not.toContain(CALL_ID);

    // The turn also has to end as a turn: a client that never sees a terminal
    // frame cannot finalize at all.
    expect(response.body).toContain('"type":"response.completed"');
  });
});
