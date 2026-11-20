import { CONNECTION_SETUP_WINDOW_MS } from "@archestra/shared/connection-setup";
import { vi } from "vitest";
import { cacheManager } from "@/cache-manager";
import config from "@/config";
import { ModelModel, VirtualApiKeyModel } from "@/models";
import GuardrailsDeploymentModel from "@/models/guardrails-deployment";
import {
  connectionSetupReference,
  issueConnectionProxySetupContext,
} from "@/services/connection-proxy-setup-context";
import { beforeEach, describe, expect, test } from "@/test";
import { createOpenAiTestClient } from "@/test/llm-provider-stubs";
import { useOpenAppaProxyHarness } from "@/test/openappa-proxy-harness";
import type { Agent } from "@/types";
import { openaiAdapterFactory } from "./adapters";
import { openAiResponsesAdapterFactory } from "./adapters/openai-responses";
import openAiProxyRoutes from "./routes/openai";

vi.mock(
  "@archestra/openappa-rs",
  async () => (await import("@/test/openappa-native-mock")).native,
);
vi.mock("@/cache-manager");

describe("OpenAPPA on the existing LLM proxy", () => {
  const h = useOpenAppaProxyHarness();

  describe("signed connection-setup proxy URL", () => {
    const prompt =
      "Read https://ai.example.com/connect.md?client=claude-code and connect Claude Code.";
    const latestUser = "B";
    const secret = "RAW SETUP TOOL OUTPUT";
    const remoteAddress = "203.0.113.44";
    const unknownAgent = "generic-installer/0.1";
    type SetupWire = "anthropic" | "openai-chat" | "openai-responses";
    type SetupAuth = "passthrough" | "virtual-key" | "raw" | "none";

    let virtualKey: string;
    let virtualKeyId: string;
    let otherVirtualKey: string;
    let otherVirtualKeyId: string;
    let passthroughToken: string;
    let passthroughKeyId: string;
    let otherPassthroughToken: string;
    let otherPassthroughKeyId: string;
    let otherAgent: Agent;

    beforeEach(
      async ({
        makeAgent,
        makeSecret,
        makeLlmProviderApiKey,
        makeUser,
        makeMember,
      }) => {
        await GuardrailsDeploymentModel.set({
          unsupportedClientAction: "block",
        });
        h.block = true;
        otherAgent = await makeAgent({
          organizationId: h.agent.organizationId,
          name: "Other proxy",
        });
        const anthropicSecret = await makeSecret({
          secret: { apiKey: "sk-ant-test" },
        });
        const anthropicKey = await makeLlmProviderApiKey(
          h.agent.organizationId,
          anthropicSecret.id,
          { provider: "anthropic" },
        );
        const openaiSecret = await makeSecret({
          secret: { apiKey: "sk-openai-test" },
        });
        const openaiKey = await makeLlmProviderApiKey(
          h.agent.organizationId,
          openaiSecret.id,
          { provider: "openai" },
        );
        const created = await VirtualApiKeyModel.create({
          organizationId: h.agent.organizationId,
          authorId: h.userId,
          name: "setup virtual",
          providerApiKeys: [
            {
              provider: anthropicKey.provider,
              providerApiKeyId: anthropicKey.id,
            },
            { provider: openaiKey.provider, providerApiKeyId: openaiKey.id },
          ],
        });
        virtualKey = created.value;
        virtualKeyId = created.virtualKey.id;
        const other = await VirtualApiKeyModel.create({
          organizationId: h.agent.organizationId,
          name: "other virtual",
          providerApiKeys: [
            {
              provider: anthropicKey.provider,
              providerApiKeyId: anthropicKey.id,
            },
            { provider: openaiKey.provider, providerApiKeyId: openaiKey.id },
          ],
        });
        otherVirtualKey = other.value;
        otherVirtualKeyId = other.virtualKey.id;
        const passthrough = await VirtualApiKeyModel.create({
          organizationId: h.agent.organizationId,
          name: "setup passthrough",
          keyType: "passthrough",
          scope: "personal",
          authorId: h.userId,
        });
        passthroughToken = passthrough.value;
        passthroughKeyId = passthrough.virtualKey.id;
        const otherUserId = (await makeUser()).id;
        await makeMember(otherUserId, h.agent.organizationId);
        const otherPassthrough = await VirtualApiKeyModel.create({
          organizationId: h.agent.organizationId,
          name: "other passthrough",
          keyType: "passthrough",
          scope: "personal",
          authorId: otherUserId,
        });
        otherPassthroughToken = otherPassthrough.value;
        otherPassthroughKeyId = otherPassthrough.virtualKey.id;
        for (const modelId of ["gpt-4o", "gpt-5.5"]) {
          await ModelModel.upsert({
            externalId: `openai/${modelId}`,
            provider: "openai",
            modelId,
            inputModalities: null,
            outputModalities: null,
            lastSyncedAt: new Date(),
          });
        }
        await h.app.register(openAiProxyRoutes);
        vi.spyOn(openaiAdapterFactory, "createClient").mockImplementation(
          () => {
            const client = createOpenAiTestClient({
              includeToolCalls: true,
              nonStreamingToolCalls: [
                {
                  id: "call_weather",
                  name: "get_weather",
                  arguments: JSON.stringify({ location: "SF" }),
                },
              ],
            });
            const create = client.chat.completions.create;
            client.chat.completions.create = async (params) => {
              h.providerRequests.push(structuredClone(params));
              return create(params);
            };
            return client as never;
          },
        );
        vi.spyOn(
          openAiResponsesAdapterFactory,
          "createClient",
        ).mockImplementation(
          () =>
            ({
              responses: {
                create: async (params: { stream?: boolean }) => {
                  h.providerRequests.push(structuredClone(params));
                  const call = {
                    id: "fc_weather",
                    call_id: "call_weather",
                    type: "function_call",
                    name: "get_weather",
                    arguments: JSON.stringify({ location: "SF" }),
                    status: "completed",
                  };
                  const response = {
                    id: "resp_setup",
                    object: "response",
                    created_at: 1,
                    status: "completed",
                    model: "gpt-5.5",
                    output: [call],
                    usage: {
                      input_tokens: 10,
                      output_tokens: 5,
                      total_tokens: 15,
                    },
                  };
                  if (params.stream) {
                    return {
                      async *[Symbol.asyncIterator]() {
                        yield {
                          type: "response.output_item.added",
                          output_index: 0,
                          sequence_number: 1,
                          item: call,
                        };
                        yield {
                          type: "response.output_item.done",
                          output_index: 0,
                          sequence_number: 2,
                          item: call,
                        };
                        yield {
                          type: "response.completed",
                          sequence_number: 3,
                          response,
                        };
                      },
                    };
                  }
                  return response;
                },
              },
            }) as never,
        );
      },
    );

    const signingSecret = () => {
      const value = config.auth.secret;
      if (!value) throw new Error("missing auth secret");
      return value;
    };

    const issueFor = (
      keyId: string,
      proxyAgentId = h.agent.id,
      organizationId = h.agent.organizationId,
    ) =>
      issueConnectionProxySetupContext({
        organizationId,
        virtualApiKeyId: keyId,
        proxyAgentId,
        setupId: crypto.randomUUID(),
        secret: signingSecret(),
      });

    const tamper = (token: string) =>
      `${token.slice(0, -1)}${token.endsWith("a") ? "b" : "a"}`;

    // What the agent that ran the installer read: its output, which ends with
    // the setup reference of the setup the token names.
    const installerOutput = (token: string) => {
      const [payload] = token.slice("cps1_".length).split(".");
      const { setupId } = JSON.parse(
        Buffer.from(payload, "base64url").toString("utf8"),
      ) as { setupId: string };
      const reference = connectionSetupReference({
        setupId,
        secret: signingSecret(),
      });
      return `${secret}\n  Setup reference   ${reference}`;
    };

    const authHeaders = (auth: SetupAuth, family: SetupWire) => {
      const headers: Record<string, string> = { "user-agent": unknownAgent };
      if (family === "anthropic") headers["anthropic-version"] = "2023-06-01";
      if (auth === "passthrough") {
        headers["x-archestra-virtual-key"] = passthroughToken;
        if (family === "anthropic")
          headers["x-api-key"] = "sk-ant-raw-provider";
        else headers.authorization = "Bearer sk-openai-raw-provider";
      } else if (auth === "virtual-key") {
        headers.authorization = `Bearer ${virtualKey}`;
      } else if (auth === "raw") {
        if (family === "anthropic")
          headers["x-api-key"] = "sk-ant-raw-provider";
        else headers.authorization = "Bearer sk-openai-raw-provider";
      }
      return headers;
    };

    const historyBody = (
      family: SetupWire,
      stream: boolean,
      deferred: boolean,
      toolOutput: string,
    ) => {
      if (family === "anthropic") {
        const body = h.payload(stream, [
          { role: "user", content: prompt },
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "toolu_old", name: "Bash", input: {} },
            ],
          },
          {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_old",
                content: toolOutput,
              },
            ],
          },
          { role: "user", content: latestUser },
        ]);
        if (!deferred) return body;
        return {
          ...body,
          tools: [
            ...body.tools,
            {
              name: "ToolSearch",
              description: "Search deferred tools",
              input_schema: { type: "object", properties: {} },
            },
            {
              name: "deferred_setup_tool",
              input_schema: { type: "object", properties: {} },
              defer_loading: true,
            },
            { type: "tool_search_tool_regex_20251119", name: "tool_search" },
          ],
        };
      }
      const tools = [
        {
          type: "function",
          name: "get_weather",
          parameters: { type: "object", properties: {} },
        },
        {
          type: "function",
          name: "ToolSearch",
          parameters: { type: "object", properties: {} },
        },
        {
          type: "function",
          name: "archestra__execute_remedy_plan",
          parameters: { type: "object", properties: {} },
        },
        {
          type: "function",
          name: "archestra__get_remedy_plans",
          parameters: { type: "object", properties: {} },
        },
        ...(deferred
          ? [
              {
                type: "function",
                name: "deferred_setup_tool",
                parameters: { type: "object", properties: {} },
                defer_loading: true,
              },
              { type: "tool_search", name: "tool_search" },
            ]
          : []),
      ];
      if (family === "openai-chat") {
        return {
          model: "gpt-4o",
          stream,
          messages: [
            { role: "user", content: prompt },
            {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call_prev",
                  type: "function",
                  function: { name: "get_weather", arguments: "{}" },
                },
              ],
            },
            { role: "tool", tool_call_id: "call_prev", content: toolOutput },
            { role: "user", content: latestUser },
          ],
          tools: tools
            .filter((tool) => tool.type === "function" && "name" in tool)
            .map((tool) => ({
              type: "function",
              function: {
                name: tool.name,
                parameters: { type: "object", properties: {} },
              },
            })),
        };
      }
      return {
        model: "gpt-5.5",
        stream,
        input: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: prompt }],
          },
          {
            type: "function_call",
            call_id: "call_prev",
            name: "get_weather",
            arguments: "{}",
          },
          {
            type: "function_call_output",
            call_id: "call_prev",
            output: toolOutput,
          },
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: latestUser }],
          },
        ],
        tools,
      };
    };

    const postSetup = (params: {
      family: SetupWire;
      stream: boolean;
      auth: SetupAuth;
      token?: string;
      profileId?: string;
      ordinary?: boolean;
      deferred?: boolean;
      knownClient?: boolean;
      malformedSession?: boolean;
      omitSession?: boolean;
      sessionId?: string;
      extraBody?: Record<string, unknown>;
      /** The earlier tool output; by default the installer's, for `token`. */
      toolOutput?: string;
      headers?: Record<string, string>;
      url?: string;
      /** Anthropic only: a continue sends just the newest user turn. */
      thread?:
        | { type: "create" }
        | { type: "continue"; previous_message_id: string };
    }) => {
      h.providerRequests.length = 0;
      h.events.length = 0;
      const profileId = params.profileId ?? h.agent.id;
      const route =
        params.family === "anthropic"
          ? `anthropic/${profileId}/v1/messages`
          : params.family === "openai-chat"
            ? `openai/${profileId}/chat/completions`
            : `openai/${profileId}/responses`;
      const headers = {
        ...authHeaders(params.auth, params.family),
        ...params.headers,
      };
      if (params.knownClient) {
        headers["user-agent"] = "claude-cli/2.1.278 (external, cli)";
        if (!params.omitSession) {
          headers["x-claude-code-session-id"] = params.malformedSession
            ? "x".repeat(513)
            : (params.sessionId ?? crypto.randomUUID());
        }
      }
      const history = historyBody(
        params.family,
        params.stream,
        params.deferred ?? true,
        params.toolOutput ??
          (params.token ? installerOutput(params.token) : secret),
      ) as Record<string, unknown>;
      return h.app.inject({
        method: "POST",
        url:
          params.url ??
          (params.ordinary || !params.token
            ? `/v1/${route}`
            : `/v1/connection-setup/${params.token}/${route}`),
        remoteAddress,
        headers,
        payload: {
          ...(params.thread?.type === "continue"
            ? {
                model: history.model,
                max_tokens: history.max_tokens,
                stream: params.stream,
                thread: params.thread,
                messages: [{ role: "user", content: latestUser }],
              }
            : params.thread
              ? { ...history, thread: params.thread }
              : history),
          ...params.extraBody,
        },
      });
    };

    const expectBypassed = (
      response: { statusCode: number; body: string },
      token: string,
    ) => {
      expect(response.statusCode, response.body).toBe(200);
      expect(response.body).toContain("get_weather");
      expect(response.body).not.toContain("archestra__get_remedy_plans");
      expect(response.body).not.toContain("NATIVE REFUSAL");
      expect(response.body).not.toContain("defers its tools");
      expect(response.body).not.toContain(
        "OpenAPPA does not recognize this client",
      );
      expect(response.body).not.toContain("cps1_");
      expect(response.body).not.toContain(token);
      expect(h.events).toEqual([]);
      expect(h.providerRequests).toHaveLength(1);
      const sent = JSON.stringify(h.providerRequests);
      expect(sent).toContain(prompt);
      expect(sent).toContain(secret);
      expect(sent).toContain('"B"');
      expect(sent).not.toContain("APPROVED REPLACEMENT");
      expect(sent).not.toContain("cps1_");
      expect(sent).not.toContain("connection-setup");
      expect(sent).not.toContain(token);
      expect(sent).not.toContain("archestra_setup_");
      expect(sent).not.toContain("archestra_con_");
    };

    const expectAdmissionBlocked = (response: {
      statusCode: number;
      body: string;
    }) => {
      expect(response.statusCode, response.body).toBe(400);
      expect(response.body).toContain(
        "OpenAPPA does not recognize this client",
      );
      expect(h.providerRequests).toHaveLength(0);
      expect(h.events).toEqual([]);
    };

    const expectStillGoverned = (response: {
      statusCode: number;
      body: string;
    }) => {
      expect(response.statusCode, response.body).toBe(200);
      expect(response.body).toContain("archestra__get_remedy_plans");
      expect(response.body).toContain("NATIVE REFUSAL");
      expect(h.events).toContainEqual(
        expect.objectContaining({ event: "tool_call", tool: "get_weather" }),
      );
      expect(h.providerRequests).toHaveLength(1);
      const sent = JSON.stringify(h.providerRequests);
      expect(sent).not.toContain(secret);
      expect(sent).toContain("APPROVED REPLACEMENT");
      expect(sent).not.toContain("cps1_");
    };

    test.each([
      ["passthrough", "anthropic", false],
      ["passthrough", "anthropic", true],
      ["passthrough", "openai-chat", false],
      ["passthrough", "openai-chat", true],
      ["passthrough", "openai-responses", false],
      ["passthrough", "openai-responses", true],
      ["virtual-key", "anthropic", false],
      ["virtual-key", "anthropic", true],
      ["virtual-key", "openai-chat", false],
      ["virtual-key", "openai-chat", true],
      ["virtual-key", "openai-responses", false],
      ["virtual-key", "openai-responses", true],
    ] as const)("signed setup URL does not bypass APPA for a %s unknown client with no session id (%s, stream=%s)", async (auth, family, stream) => {
      const token = issueFor(
        auth === "passthrough" ? passthroughKeyId : virtualKeyId,
      );
      const response = await postSetup({
        family,
        stream,
        auth,
        token,
        deferred: true,
      });
      expectAdmissionBlocked(response);
    });

    test("signed setup URL does not bypass a malformed session id or a known client that sends no session id", async () => {
      const token = issueFor(passthroughKeyId);
      const malformed = await postSetup({
        family: "anthropic",
        stream: false,
        auth: "passthrough",
        token,
        knownClient: true,
        malformedSession: true,
        deferred: true,
      });
      expect(malformed.statusCode, malformed.body).toBe(400);
      expect(malformed.body).toContain("valid client-native session ID");
      expect(h.providerRequests).toHaveLength(0);

      const streamedMalformed = await postSetup({
        family: "anthropic",
        stream: true,
        auth: "passthrough",
        token,
        knownClient: true,
        malformedSession: true,
        deferred: true,
      });
      expect(streamedMalformed.statusCode, streamedMalformed.body).toBe(400);
      expect(streamedMalformed.body).toContain(
        "valid client-native session ID",
      );
      expect(h.providerRequests).toHaveLength(0);

      const noSession = await postSetup({
        family: "anthropic",
        stream: false,
        auth: "passthrough",
        token,
        knownClient: true,
        omitSession: true,
        deferred: true,
      });
      expectStillGoverned(noSession);

      const rejected = await postSetup({
        family: "anthropic",
        stream: false,
        auth: "passthrough",
        token: tamper(token),
        knownClient: true,
        malformedSession: true,
        deferred: true,
      });
      expect(rejected.statusCode, rejected.body).toBe(400);
      expect(rejected.body).toContain("valid client-native session ID");
      expect(h.providerRequests).toHaveLength(0);
      expect(h.events).toEqual([]);

      const governed = await postSetup({
        family: "anthropic",
        stream: false,
        auth: "passthrough",
        ordinary: true,
        knownClient: true,
        omitSession: true,
        deferred: false,
      });
      expectStillGoverned(governed);
    });

    test("tampered, cross-key, cross-proxy, and cross-org tokens do not bypass APPA", async () => {
      const cases: Array<{
        label: string;
        token: string;
        auth: SetupAuth;
        profileId?: string;
        headers?: Record<string, string>;
      }> = [
        {
          label: "tampered",
          token: tamper(issueFor(passthroughKeyId)),
          auth: "passthrough",
        },
        {
          label: "cross-org",
          token: issueFor(passthroughKeyId, h.agent.id, crypto.randomUUID()),
          auth: "passthrough",
        },
        {
          label: "cross-proxy",
          token: issueFor(passthroughKeyId, otherAgent.id),
          auth: "passthrough",
        },
        {
          label: "token for this proxy used on the other proxy",
          token: issueFor(virtualKeyId),
          auth: "virtual-key",
          profileId: otherAgent.id,
        },
        {
          label: "cross-passthrough-key",
          token: issueFor(otherPassthroughKeyId),
          auth: "passthrough",
        },
        {
          label: "other passthrough key presented against this token",
          token: issueFor(passthroughKeyId),
          auth: "passthrough",
          headers: { "x-archestra-virtual-key": otherPassthroughToken },
        },
        {
          label: "cross-virtual-key",
          token: issueFor(otherVirtualKeyId),
          auth: "virtual-key",
        },
        {
          label: "standard token presented with a passthrough key",
          token: issueFor(virtualKeyId),
          auth: "passthrough",
        },
        {
          label: "passthrough token presented with a standard key",
          token: issueFor(passthroughKeyId),
          auth: "virtual-key",
        },
      ];
      for (const item of cases) {
        const response = await postSetup({
          family: "anthropic",
          stream: false,
          auth: item.auth,
          token: item.token,
          profileId: item.profileId,
          headers: item.headers,
          deferred: true,
        });
        expect(response.statusCode, `${item.label}: ${response.body}`).toBe(
          400,
        );
        expect(response.body, item.label).toContain(
          "OpenAPPA does not recognize this client",
        );
        expect(h.providerRequests, item.label).toHaveLength(0);
        expect(h.events, item.label).toEqual([]);
      }

      const governed = await postSetup({
        family: "anthropic",
        stream: false,
        auth: "passthrough",
        token: tamper(issueFor(passthroughKeyId)),
        knownClient: true,
        deferred: false,
      });
      expectStillGoverned(governed);

      const otherKeyGoverned = await postSetup({
        family: "anthropic",
        stream: false,
        auth: "virtual-key",
        token: issueFor(virtualKeyId),
        knownClient: true,
        deferred: false,
        headers: { authorization: `Bearer ${otherVirtualKey}` },
      });
      expectStillGoverned(otherKeyGoverned);
    });

    test("the setup URL exempts nothing in a session started after the setup", async () => {
      const token = issueFor(passthroughKeyId);
      // The installer's conversation is exempt...
      expectBypassed(
        await postSetup({
          family: "anthropic",
          stream: false,
          auth: "passthrough",
          token,
          knownClient: true,
          deferred: true,
        }),
        token,
      );
      // ...but a new session sends the same URL from the client's settings,
      // and its history holds no setup reference.
      expectStillGoverned(
        await postSetup({
          family: "anthropic",
          stream: false,
          auth: "passthrough",
          token,
          knownClient: true,
          toolOutput: secret,
          deferred: true,
        }),
      );
      // The reference of another setup does not count either.
      expectAdmissionBlocked(
        await postSetup({
          family: "anthropic",
          stream: false,
          auth: "passthrough",
          token,
          toolOutput: installerOutput(issueFor(passthroughKeyId)),
          deferred: true,
        }),
      );
    });

    test("a copied setup reference does not exempt a second native conversation", async () => {
      const token = issueFor(passthroughKeyId);
      const owner = "11111111-1111-4111-8111-111111111111";
      const copier = "22222222-2222-4222-8222-222222222222";
      expectBypassed(
        await postSetup({
          family: "anthropic",
          stream: false,
          auth: "passthrough",
          token,
          knownClient: true,
          sessionId: owner,
          deferred: true,
        }),
        token,
      );
      expectStillGoverned(
        await postSetup({
          family: "anthropic",
          stream: false,
          auth: "passthrough",
          token,
          knownClient: true,
          sessionId: copier,
          deferred: true,
        }),
      );
      expectBypassed(
        await postSetup({
          family: "anthropic",
          stream: false,
          auth: "passthrough",
          token,
          knownClient: true,
          sessionId: owner,
          deferred: true,
        }),
        token,
      );
      expectStillGoverned(
        await postSetup({
          family: "anthropic",
          stream: false,
          auth: "passthrough",
          token,
          knownClient: true,
          sessionId: owner,
          toolOutput: secret,
          deferred: true,
        }),
      );
    });

    test("a parent session id or a cache error does not claim the setup reference", async () => {
      const token = issueFor(passthroughKeyId);
      const parentOnly = await postSetup({
        family: "anthropic",
        stream: false,
        auth: "passthrough",
        token,
        knownClient: true,
        omitSession: true,
        deferred: true,
        extraBody: {
          metadata: {
            user_id: JSON.stringify({
              parent_session_id: "33333333-3333-4333-8333-333333333333",
            }),
          },
        },
      });
      expectStillGoverned(parentOnly);

      vi.spyOn(cacheManager, "withLock").mockRejectedValueOnce(
        new Error("cache down"),
      );
      try {
        expectStillGoverned(
          await postSetup({
            family: "anthropic",
            stream: false,
            auth: "passthrough",
            token,
            knownClient: true,
            sessionId: "44444444-4444-4444-8444-444444444444",
            deferred: true,
          }),
        );
      } finally {
        vi.mocked(cacheManager.withLock).mockRestore();
      }
    });

    test("a provider-thread continue in the installer's conversation replays, and the replay stays exempt", async () => {
      const token = issueFor(passthroughKeyId);
      // The installer's output is earlier in the thread, not in this continue,
      // so the request is governed, and no thread state exists for it.
      const continued = await postSetup({
        family: "anthropic",
        stream: false,
        auth: "passthrough",
        token,
        knownClient: true,
        thread: { type: "continue", previous_message_id: "msg_in_setup" },
      });
      expect(continued.statusCode, continued.body).toBe(404);
      expect(continued.json()).toMatchObject({
        error: { details: { error_code: "thread_not_found" } },
      });
      expect(h.providerRequests).toHaveLength(0);
      // Claude Code replays the whole conversation, which holds the reference.
      expectBypassed(
        await postSetup({
          family: "anthropic",
          stream: false,
          auth: "passthrough",
          token,
          knownClient: true,
          thread: { type: "create" },
        }),
        token,
      );
    });

    test("an unrelated deferred request without the setup URL is governed, not refused", async () => {
      // A tool search defers some tools; the calls the model makes are still
      // ruled on, and a denial still comes back as a notice.
      const anthropic = await postSetup({
        family: "anthropic",
        stream: false,
        auth: "passthrough",
        ordinary: true,
        knownClient: true,
        deferred: true,
      });
      expectStillGoverned(anthropic);

      h.providerRequests.length = 0;
      h.events.length = 0;
      const responses = await postSetup({
        family: "openai-responses",
        stream: false,
        auth: "virtual-key",
        ordinary: true,
        knownClient: true,
        deferred: true,
        headers: {
          "user-agent": "codex_cli_rs/0.154.0",
          originator: "codex_cli_rs",
          "x-codex-turn-metadata": JSON.stringify({
            thread_id: crypto.randomUUID(),
          }),
        },
      });
      expectStillGoverned(responses);
    });

    test("prompt history without a pending browser copy or setup URL does not bypass APPA", async () => {
      const response = await postSetup({
        family: "anthropic",
        stream: false,
        auth: "passthrough",
        ordinary: true,
        deferred: true,
      });
      expectAdmissionBlocked(response);
      expect(response.body).not.toContain("get_weather");
    });

    test("a capability URL without credentials returns 401", async () => {
      const token = issueFor(passthroughKeyId);
      const response = await postSetup({
        family: "anthropic",
        stream: false,
        auth: "none",
        token,
        deferred: true,
      });
      expect(response.statusCode, response.body).toBe(401);
      expect(response.body).toContain("Authentication required");
      expect(response.body).not.toContain(
        "OpenAPPA requires an authenticated proxy request",
      );
      expect(h.providerRequests).toHaveLength(0);
      expect(h.events).toEqual([]);
      expect(response.body).not.toContain("get_weather");
    });

    test("a raw provider key does not bypass APPA through the setup URL", async () => {
      // Even where the organization admits a bare provider key, OpenAPPA
      // refuses a governed request that carries no platform credential.
      await h.allowUnauthenticatedCallers();
      for (const token of [
        issueFor(passthroughKeyId),
        issueFor(virtualKeyId),
      ]) {
        const response = await postSetup({
          family: "anthropic",
          stream: false,
          auth: "raw",
          token,
          deferred: true,
        });
        expect(response.statusCode, response.body).toBe(401);
        expect(response.body).toContain(
          "OpenAPPA requires an authenticated proxy request",
        );
        expect(h.providerRequests).toHaveLength(0);
        expect(h.events).toEqual([]);
      }

      const openai = await postSetup({
        family: "openai-chat",
        stream: false,
        auth: "raw",
        token: issueFor(passthroughKeyId),
        deferred: true,
      });
      expect(openai.statusCode, openai.body).toBe(401);
      expect(openai.body).toContain(
        "OpenAPPA requires an authenticated proxy request",
      );
      expect(h.providerRequests).toHaveLength(0);
    });

    test("a forged header on the ordinary route cannot carry the setup capability", async () => {
      const token = issueFor(passthroughKeyId);
      const response = await postSetup({
        family: "anthropic",
        stream: false,
        auth: "passthrough",
        ordinary: true,
        deferred: true,
        headers: {
          "x-connection-setup-context": token,
          "x-appa-setup": token,
        },
        url: `${h.url()}?archestra_setup_ctx=${encodeURIComponent(token)}`,
      });
      expectAdmissionBlocked(response);
    });

    test("a malformed capability prefix still reaches the provider route and does not bypass APPA", async () => {
      const response = await postSetup({
        family: "anthropic",
        stream: false,
        auth: "passthrough",
        deferred: true,
        url: `/v1/connection-setup/not-a-token/anthropic/${h.agent.id}/v1/messages`,
      });
      expect(response.statusCode).not.toBe(404);
      expectAdmissionBlocked(response);
    });

    test("the setup capability is invalid before issuance and expires at the setup window", async () => {
      const issuedAt = new Date("2026-09-29T12:00:00.000Z");
      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        vi.setSystemTime(issuedAt);
        const passthroughCap = issueFor(passthroughKeyId);
        const virtualCap = issueFor(virtualKeyId);

        vi.setSystemTime(issuedAt.getTime() - 1);
        const early = await postSetup({
          family: "anthropic",
          stream: false,
          auth: "passthrough",
          token: passthroughCap,
          deferred: true,
        });
        expectAdmissionBlocked(early);

        vi.setSystemTime(issuedAt.getTime() + CONNECTION_SETUP_WINDOW_MS - 1);
        const stillValid = await postSetup({
          family: "anthropic",
          stream: false,
          auth: "passthrough",
          token: passthroughCap,
          knownClient: true,
          sessionId: "11111111-1111-4111-8111-111111111111",
          deferred: true,
        });
        expectBypassed(stillValid, passthroughCap);
        const virtualStillValid = await postSetup({
          family: "openai-chat",
          stream: true,
          auth: "virtual-key",
          token: virtualCap,
          knownClient: true,
          sessionId: "22222222-2222-4222-8222-222222222222",
          deferred: true,
        });
        expectBypassed(virtualStillValid, virtualCap);

        vi.setSystemTime(issuedAt.getTime() + CONNECTION_SETUP_WINDOW_MS);
        const expired = await postSetup({
          family: "anthropic",
          stream: true,
          auth: "passthrough",
          token: passthroughCap,
          deferred: true,
        });
        expectAdmissionBlocked(expired);
        const virtualExpired = await postSetup({
          family: "openai-responses",
          stream: false,
          auth: "virtual-key",
          token: virtualCap,
          deferred: true,
        });
        expectAdmissionBlocked(virtualExpired);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
