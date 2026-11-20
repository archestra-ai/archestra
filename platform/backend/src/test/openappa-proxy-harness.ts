/**
 * Shared setup for the `llm-proxy-openappa*.test.ts` files: OpenAPPA on the
 * existing Anthropic LLM proxy, with the native runtime replaced by
 * `@/test/openappa-native-mock`. Each file must mock `@archestra/openappa-rs`
 * with that module before calling {@link useOpenAppaProxyHarness}.
 */
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import Fastify from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { vi } from "vitest";
import { internalCallHeader } from "@/clients/internal-call";
import config, { parseLlmProxyPlugins, parseOpenAppaConfig } from "@/config";
import db, * as database from "@/database";
import { InteractionModel, ModelModel, VirtualApiKeyModel } from "@/models";
import GuardrailsDeploymentModel from "@/models/guardrails-deployment";
import OrganizationModel from "@/models/organization";
import { openappaActor } from "@/openappa/actor";
import { createAppaLlmProxyPlugin } from "@/proxy/plugins/appa-plugin-archestra";
import { registerLlmProxyPlugin } from "@/proxy/plugins/registry";
import { anthropicAdapterFactory } from "@/routes/proxy/adapters";
import anthropicProxyRoutes from "@/routes/proxy/routes/anthropic";
import { rewriteConnectionProxySetupUrl } from "@/services/connection-proxy-setup-context";
import { afterEach, beforeEach, expect } from "@/test";
import {
  type AnthropicStubOptions,
  createAnthropicTestClient,
} from "@/test/llm-provider-stubs";
import { makePassthroughCredential } from "@/test/llm-proxy-credentials";
import { native } from "@/test/openappa-native-mock";
import { type Agent, ApiError } from "@/types";

export interface OpenAppaProxyHarness {
  app: FastifyInstance;
  agent: Agent;
  userId: string;
  /** The passthrough virtual key the client sends beside its provider key. */
  platformKey: string;
  sessionId: string;
  /** The external client's personal platform virtual key. */
  externalCredential: string;
  options: AnthropicStubOptions;
  providerRequests: unknown[];
  providerResponses: unknown[];
  events: Array<Record<string, unknown>>;
  block: boolean;
  fail: boolean;
  failure: Error;
  /** A tool whose annotator gives no answer, as the runtime reports it. */
  unruled: string | undefined;
  unregisterAppaPlugin: () => void;
  payload: (
    stream?: boolean,
    messages?: unknown[],
  ) => {
    model: string;
    max_tokens: number;
    stream: boolean;
    messages: unknown[];
    tools: Array<{
      name: string;
      description: string;
      input_schema: Record<string, unknown>;
    }>;
  };
  headers: () => Record<string, string>;
  url: () => string;
  post: (
    payloadBody: unknown,
    extraHeaders?: Record<string, string>,
  ) => Promise<LightMyRequestResponse>;
  /**
   * `headers()` without the platform credential: a caller holding only a
   * provider key, whose user and session headers are claims nobody verified.
   * Such a caller reaches OpenAPPA only where the organization allows
   * unauthenticated proxy requests, so the cases about it turn that on with
   * `allowUnauthenticatedCallers`.
   */
  unauthenticatedHeaders: () => Record<string, string>;
  allowUnauthenticatedCallers: () => ReturnType<typeof OrganizationModel.patch>;
  /** An external client: no APPA header, and not Chat's internal source. */
  externalClientHeaders: () => Record<string, string>;
}

/**
 * Registers the per-test proxy setup in the calling `describe` and returns the
 * state it fills in. Tests read and assign its fields (`h.block = true`).
 */
export function useOpenAppaProxyHarness(): OpenAppaProxyHarness {
  const h = {} as OpenAppaProxyHarness;
  Object.assign(h, {
    payload: (
      stream = true,
      messages: unknown[] = [{ role: "user", content: "Check the weather" }],
    ) => ({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 1024,
      stream,
      messages,
      tools: [
        {
          name: "get_weather",
          description: "Weather",
          input_schema: {
            type: "object",
            properties: { location: { type: "string" } },
          },
        },
        // A stock client declares both APPA tools through the platform's own MCP
        // endpoint; a session without them is refused before the provider is called.
        {
          name: "archestra__execute_remedy_plan",
          description: "Execute a remedy",
          input_schema: { type: "object", properties: {} },
        },
        {
          name: "archestra__get_remedy_plans",
          description: "Read a ruling",
          input_schema: { type: "object", properties: {} },
        },
      ],
    }),
    headers: (): Record<string, string> => ({
      "x-api-key": "test-key",
      "x-archestra-virtual-key": h.platformKey,
      "anthropic-version": "2023-06-01",
      "x-archestra-source": "chat",
      "x-archestra-user-id": h.userId,
      "x-appa-session-id": h.sessionId,
    }),
    url: () => `/v1/anthropic/${h.agent.id}/v1/messages`,
    post: (payloadBody: unknown, extraHeaders: Record<string, string> = {}) =>
      h.app.inject({
        method: "POST",
        url: h.url(),
        remoteAddress: "127.0.0.1",
        headers: { ...internalCallHeader(), ...h.headers(), ...extraHeaders },
        payload: payloadBody as Record<string, unknown>,
      }),
    unauthenticatedHeaders: () => {
      const { "x-archestra-virtual-key": _platformKey, ...rest } = h.headers();
      return rest;
    },
    allowUnauthenticatedCallers: () =>
      OrganizationModel.patch(h.agent.organizationId, {
        allowUnauthenticatedLlmProxyRequests: true,
      }),
    externalClientHeaders: () => ({
      ...Object.fromEntries(
        Object.entries(h.headers()).filter(
          ([name]) =>
            name !== "x-appa-session-id" &&
            name !== "x-archestra-source" &&
            name !== "x-api-key" &&
            name !== "x-archestra-virtual-key",
        ),
      ),
      authorization: `Bearer ${h.externalCredential}`,
    }),
  } satisfies Partial<OpenAppaProxyHarness>);

  beforeEach(
    async ({
      makeAgent,
      makeConversation,
      makeLlmProviderApiKey,
      makeMember,
      makeSecret,
      makeUser,
    }) => {
      // These provider stubs exercise direct Anthropic credentials, independent
      // of a developer's configured Vertex project.
      config.llm.anthropic.vertexAi.enabled = false;
      config.openappa = parseOpenAppaConfig();
      // The server flag alone no longer enforces: the deployment-wide switch has
      // to be on too, and every case here is about APPA actually enforcing.
      await GuardrailsDeploymentModel.setEnabled(true);
      config.llmProxy.plugins = parseLlmProxyPlugins(undefined);
      h.unregisterAppaPlugin = registerLlmProxyPlugin(
        createAppaLlmProxyPlugin(),
      );
      vi.spyOn(database, "getDatabaseConnectionString").mockReturnValue(
        "postgresql://test:test@localhost/test?schema=public",
      );
      h.app = Fastify({
        rewriteUrl: rewriteConnectionProxySetupUrl,
      }).withTypeProvider<ZodTypeProvider>();
      h.app.setValidatorCompiler(validatorCompiler);
      h.app.setSerializerCompiler(serializerCompiler);
      h.app.setErrorHandler((error, _request, reply) => {
        // Relays retry guidance as the central handler does (server.test.ts).
        if (error instanceof ApiError && typeof error.shouldRetry === "boolean")
          reply.header("x-should-retry", String(error.shouldRetry));
        return reply
          .status(error instanceof ApiError ? error.statusCode : 500)
          .send({
            error: {
              message: error instanceof Error ? error.message : String(error),
              type:
                error instanceof ApiError
                  ? error.type
                  : "api_internal_server_error",
            },
          });
      });
      await h.app.register(anthropicProxyRoutes);
      h.agent = await makeAgent({ name: "Native proxy test" });
      h.userId = (await makeUser()).id;
      await makeMember(h.userId, h.agent.organizationId);
      h.platformKey = await makePassthroughCredential({
        organizationId: h.agent.organizationId,
        ownerId: h.userId,
      });
      // External clients present a platform credential, as any non-internal
      // caller must; a bare provider key does not identify the caller to APPA.
      const externalSecret = await makeSecret({
        secret: { apiKey: "sk-external" },
      });
      const externalProviderKey = await makeLlmProviderApiKey(
        h.agent.organizationId,
        externalSecret.id,
        { provider: "anthropic" },
      );
      h.externalCredential = (
        await VirtualApiKeyModel.create({
          name: "external-client",
          authorId: h.userId,
          scope: "personal",
          providerApiKeys: [
            {
              provider: externalProviderKey.provider,
              providerApiKeyId: externalProviderKey.id,
            },
          ],
        })
      ).value;
      h.sessionId = (
        await makeConversation(h.agent.id, {
          userId: h.userId,
          organizationId: h.agent.organizationId,
        })
      ).id;
      h.options = {
        includeToolUse: true,
        streamStopReason: "tool_use",
        nonStreamingToolUse: { name: "get_weather", input: { location: "SF" } },
      };
      h.providerRequests = [];
      h.providerResponses = [];
      h.events = [];
      h.block = false;
      h.fail = false;
      h.failure = new Error("private native database error");
      h.unruled = undefined;
      native.initializeOpenappa.mockResolvedValue(undefined);
      // Mirrors the real binding closely enough to be regression coverage: the
      // runtime remembers which call it denied, and answers that call's result
      // with its own ruling rather than with anything the client reported.
      const denied = new Set<string>();
      native.dispatchHook.mockImplementation(async (raw: string) => {
        const event = JSON.parse(raw);
        h.events.push(event);
        if (event.event === "session_start") {
          const runtimeSessionId = String(event.session_id);
          await db
            .insert(database.schema.openappaSessionsTable)
            .values({
              actor: openappaActor(runtimeSessionId),
              root: openappaActor(runtimeSessionId),
              organizationId: String(event.organization_id),
              callerId:
                typeof event.caller_id === "string" ? event.caller_id : null,
              sessionId: runtimeSessionId,
              parentId:
                typeof event.parent_id === "string" ? event.parent_id : null,
              forkedFrom:
                typeof event.fork_of === "string" ? event.fork_of : null,
              startDecision: { decision: "ack" },
            })
            .onConflictDoNothing();
        }
        if (event.event === "tool_call") {
          if (h.fail) throw h.failure;
          if (event.tool === h.unruled)
            throw new Error(
              "OpenAPPA processing interrupted: annotator=archestra.tool-call error=timeout",
            );
          if (!h.block || event.tool === "allowed_first")
            return JSON.stringify({
              decision: "allow_call",
              ...(event.spawn
                ? { spawn_binding: `fork:${event.operation_id}` }
                : {}),
            });
          denied.add(String(event.operation_id).replace(/^call:/, ""));
          return JSON.stringify({
            decision: "deny_call",
            feedback:
              "[appa] NATIVE REFUSAL: execute_remedy_plan(offer_id: test-offer)",
          });
        }
        if (event.event === "tool_result") {
          return JSON.stringify(
            denied.has(String(event.tool_call_id))
              ? {
                  decision: "deny_call",
                  feedback:
                    "[appa] NATIVE REFUSAL: execute_remedy_plan(offer_id: test-offer)",
                  approved_output:
                    "[appa] NATIVE REFUSAL: execute_remedy_plan(offer_id: test-offer)",
                  output_source: "runtime",
                }
              : {
                  decision: "replace_output",
                  approved_output: "APPROVED REPLACEMENT",
                  output_source: "tool",
                },
          );
        }
        return JSON.stringify({ decision: "ack" });
      });
      vi.spyOn(anthropicAdapterFactory, "createClient").mockImplementation(
        () => {
          const client = createAnthropicTestClient(h.options);
          const create = client.messages.create;
          client.messages.create = async (params) => {
            h.providerRequests.push(structuredClone(params));
            const response = await create(params);
            h.providerResponses.push(response);
            return response;
          };
          return client as never;
        },
      );
      await ModelModel.upsert({
        externalId: "anthropic/claude-3-5-sonnet-20241022",
        provider: "anthropic",
        modelId: "claude-3-5-sonnet-20241022",
        inputModalities: null,
        outputModalities: null,
        lastSyncedAt: new Date(),
      });
    },
  );

  afterEach(async () => {
    h.unregisterAppaPlugin();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await h.app.close();
  });

  return h;
}

/** The notice call the client received, arguments included. */
export const noticeFrom = (body: string, stream: boolean) => {
  if (!stream) {
    const call = (
      (JSON.parse(body).content ?? []) as Record<string, unknown>[]
    ).findLast((block) => block.type === "tool_use");
    return {
      name: call?.name as string,
      id: call?.id as string,
      input: call?.input as Record<string, unknown>,
    };
  }
  const events = body
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice("data: ".length)));
  const start = events.findLast(
    (event) => event.type === "content_block_start",
  );
  // Only this block's deltas: a batch streams other calls' arguments too.
  const partial = events
    .filter(
      (event) =>
        event.delta?.type === "input_json_delta" &&
        event.index === start?.index,
    )
    .map((event) => event.delta.partial_json)
    .join("");
  return {
    name: start?.content_block?.name as string,
    id: start?.content_block?.id as string,
    input: (partial.length > 0
      ? JSON.parse(partial)
      : start?.content_block?.input) as Record<string, unknown>,
  };
};

export const childReturnCarrier = (body: string, value: string): string => {
  const match = body.match(
    /(?:finished subagent|finished protected subagent|protected subagent session|protected subagent return|protected delegated return) (?:([A-Za-z0-9_-]+)\s+)?([0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{4})/,
  );
  const childTag = match?.[1] ? `${match[1]} ` : "";
  const code = match?.[2];
  expect(code, body).toBeDefined();
  const marker = `▄█▄▄▄█▄\n██▄█▄██  finished subagent ${childTag}${code}`;
  return `${value}\n\n${marker}`;
};

/** One streamed Responses API answer, as a Codex client receives it. */
export function codexResponseStream(
  id: string,
  output: Record<string, unknown>[],
) {
  return {
    async *[Symbol.asyncIterator]() {
      yield {
        type: "response.created",
        sequence_number: 0,
        response: {
          id: id,
          object: "response",
          status: "in_progress",
          model: "gpt-5.5",
          output: [],
        },
      };
      for (const [index, item] of output.entries()) {
        yield {
          type: "response.output_item.added",
          output_index: index,
          sequence_number: index * 3 + 1,
          item:
            item.type === "function_call"
              ? { ...item, arguments: "", status: "in_progress" }
              : { ...item, content: [], status: "in_progress" },
        };
        if (item.type === "function_call") {
          yield {
            type: "response.function_call_arguments.delta",
            item_id: item.id,
            output_index: index,
            sequence_number: index * 3 + 2,
            delta: item.arguments,
          };
        } else {
          const text = String(
            (item.content as { text?: string }[] | undefined)?.[0]?.text ?? "",
          );
          yield {
            type: "response.output_text.delta",
            item_id: item.id,
            output_index: index,
            content_index: 0,
            sequence_number: index * 3 + 2,
            delta: text,
          };
        }
        yield {
          type: "response.output_item.done",
          output_index: index,
          sequence_number: index * 3 + 3,
          item,
        };
      }
      yield {
        type: "response.completed",
        sequence_number: output.length * 3 + 4,
        response: {
          id: id,
          object: "response",
          status: "completed",
          model: "gpt-5.5",
          output,
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            total_tokens: 15,
          },
        },
      };
    },
  };
}

export function wrapAsyncIterator<T>(
  stream: AsyncGenerator<T, undefined, unknown>,
) {
  return {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          const next = await stream.next();
          return next.done
            ? { done: true, value: undefined }
            : { done: false, value: next.value };
        },
      };
    },
  };
}

/** The response the interaction log recorded for the profile's latest turn. */
export async function latestLoggedResponse(profileId: string): Promise<string> {
  // A streamed turn is logged once the client's response has ended.
  return await vi.waitFor(async () => {
    const latest = (
      await InteractionModel.getAllInteractionsForProfile(profileId)
    ).at(-1);
    if (!latest) throw new Error("nothing logged yet");
    return JSON.stringify(latest.response);
  });
}
