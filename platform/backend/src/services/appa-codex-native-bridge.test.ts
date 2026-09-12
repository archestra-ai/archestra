import { createHash, randomUUID } from "node:crypto";
import { toMcpClientServerName } from "@archestra/shared";
import { HttpResponse, http } from "msw";
import config from "@/config";
import AppaProxyWireModel from "@/models/appa-proxy-wire";
import { AppaProxyHookSession } from "@/routes/proxy/appa-proxy-hook";
import { describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import {
  createNativeCodexBootstrap,
  isNativeCodexCodeModeRequest,
  issuedCodexToolSearchMcpTargets,
  issueNativeCodexFrame,
  loadIssuedCodexToolSearchRegistry,
  prepareNativeCodexCallAliases,
  projectNativeCodexModelRequest,
  recordNativeCodexDiscovery,
  resolveNativeCodexGatewayPrincipals,
  restoreNativeCodexProviderIds,
  rewriteNativeCodexResponseForClient,
} from "./appa-codex-native-bridge";

const runtimeUrl = "http://native-bridge.test";
// biome-ignore lint/correctness/useHookAtTopLevel: vitest lifecycle helper for HTTP boundary tests
const server = useMswServer();

describe("isNativeCodexCodeModeRequest", () => {
  test("derives a provider-only native principal only from a registered gateway", async ({
    makeAgent,
    makeMember,
    makeOrganization,
    makeUser,
  }) => {
    const organization = await makeOrganization();
    const owner = await makeUser();
    await makeMember(owner.id, organization.id, { role: "admin" });
    const gateway = await makeAgent({
      organizationId: organization.id,
      authorId: owner.id,
      agentType: "mcp_gateway",
      name: "Provider-only native gateway",
    });
    const namespace = `mcp__${toMcpClientServerName(gateway.name)}`;

    await expect(
      resolveNativeCodexGatewayPrincipals({
        organizationId: organization.id,
        registry: [{ namespace, name: "fixture__write", kind: "function" }],
      }),
    ).resolves.toEqual(
      new Map([
        [
          namespace,
          { principalUserId: owner.id, gatewayProfileId: gateway.id },
        ],
      ]),
    );
    await expect(
      resolveNativeCodexGatewayPrincipals({
        organizationId: organization.id,
        registry: [
          {
            namespace: "mcp__unregistered",
            name: "fixture__write",
            kind: "function",
          },
        ],
      }),
    ).resolves.toEqual(new Map());
  });

  test("requires the Code Mode functions.exec declaration", () => {
    expect(
      isNativeCodexCodeModeRequest({
        input: [
          {
            type: "additional_tools",
            tools: [
              {
                type: "namespace",
                name: "functions",
                tools: [
                  { type: "custom", name: "exec" },
                  { type: "function", name: "wait" },
                ],
              },
            ],
          },
        ],
      }),
    ).toBe(true);
  });

  test("does not treat wait alone as a native bootstrap proof", () => {
    expect(
      isNativeCodexCodeModeRequest({
        input: [
          {
            type: "additional_tools",
            tools: [
              {
                type: "namespace",
                name: "functions",
                tools: [{ type: "function", name: "wait" }],
              },
            ],
          },
        ],
      }),
    ).toBe(false);
  });

  test("accepts the stock top-level Responses native tool manifest", () => {
    expect(
      isNativeCodexCodeModeRequest({
        input: [{ type: "message", role: "user", content: "inspect" }],
        tools: [
          {
            type: "function",
            name: "exec_command",
            strict: false,
            parameters: {
              type: "object",
              properties: { cmd: { type: "string" } },
              required: ["cmd"],
              additionalProperties: false,
            },
          },
          {
            type: "function",
            name: "write_stdin",
            strict: false,
            parameters: {
              type: "object",
              properties: {
                session_id: { type: "string" },
                chars: { type: "string" },
              },
              required: ["session_id", "chars"],
              additionalProperties: false,
            },
          },
          { type: "custom", name: "apply_patch" },
        ],
      }),
    ).toBe(true);
  });

  test("does not accept a custom or incomplete top-level tool declaration", () => {
    expect(
      isNativeCodexCodeModeRequest({
        tools: [
          { type: "custom", name: "exec" },
          {
            type: "function",
            name: "exec_command",
            parameters: { type: "object", required: ["cmd"] },
          },
        ],
      }),
    ).toBe(false);
  });

  test("registers stock Responses declarations without issuing a custom bootstrap", async ({
    makeAgent,
  }) => {
    config.llmProxy.appaHook = nativeHookConfig();
    const agent = await makeAgent();
    const session = await AppaProxyHookSession.acquire({
      config: nativeHookConfig(),
      profileId: agent.id,
      ownerScopeHash: `native-bridge-owner-${randomUUID()}`,
      clientSessionId: `native-bridge-thread-${randomUUID()}`,
      toolResults: [],
    });
    const request = stockResponsesRequest();

    const registry = await recordNativeCodexDiscovery({ session, request });
    const projected = await projectNativeCodexModelRequest({
      session,
      request,
      registry: registry ?? [],
    });

    expect(registry).toEqual([
      { namespace: "functions", name: "exec_command", kind: "function" },
      { namespace: "functions", name: "write_stdin", kind: "function" },
      { namespace: "functions", name: "apply_patch", kind: "custom" },
    ]);
    expect(projected.tools).toEqual(request.tools);
    expect(JSON.stringify(projected)).not.toContain('"name":"exec"');
    expect(
      await AppaProxyWireModel.listIssuedAliases(session.getNativeWireScope()),
    ).toEqual([]);

    const providerCall = {
      id: "fc_provider_exec",
      type: "function_call",
      call_id: "call_provider_exec",
      name: "exec_command",
      arguments: '{"cmd":"printf standard"}',
    };
    const prepared = await prepareNativeCodexCallAliases({
      session,
      request,
      response: { output: [providerCall] },
      calls: [
        {
          id: providerCall.call_id,
          name: providerCall.name,
          arguments: providerCall.arguments,
        },
      ],
    });
    await issueNativeCodexFrame({ session, frameId: prepared.frameId });
    const clientCallId = prepared.calls[0]?.id;
    if (!clientCallId) throw new Error("standard call was not allocated");

    await expect(
      projectNativeCodexModelRequest({
        session,
        registry: registry ?? [],
        request: {
          ...stockResponsesRequest(),
          input: [
            {
              ...providerCall,
              id: `fc_${clientCallId}`,
              call_id: clientCallId,
            },
            {
              type: "function_call_output",
              call_id: clientCallId,
              output: "standard result",
            },
          ],
        },
      }),
    ).resolves.toMatchObject({
      input: [
        providerCall,
        {
          type: "function_call_output",
          call_id: providerCall.call_id,
          output: "standard result",
        },
      ],
    });

    // A stock client can report a local tool failure before the provider sees
    // the result. Its call ID must still bind to the issued response frame.
    await expect(
      projectNativeCodexModelRequest({
        session,
        registry: registry ?? [],
        request: {
          ...stockResponsesRequest(),
          input: [
            {
              ...providerCall,
              id: `fc_${clientCallId}`,
              call_id: clientCallId,
            },
            {
              type: "function_call_output",
              call_id: clientCallId,
              output: {
                error: "local approval refused the issued call",
              },
            },
          ],
        },
      }),
    ).resolves.toMatchObject({
      input: [
        providerCall,
        {
          type: "function_call_output",
          call_id: providerCall.call_id,
          output: {
            error: "local approval refused the issued call",
          },
        },
      ],
    });
  });

  test("returns apply_patch on the client custom-tool wire", () => {
    expect(
      rewriteNativeCodexResponseForClient({
        output: [
          {
            id: "item-1",
            type: "function_call",
            call_id: "call-1",
            namespace: "functions",
            name: "apply_patch",
            arguments: '{"input":"*** Begin Patch"}',
          },
        ],
      }),
    ).toEqual({
      output: [
        {
          id: "item-1",
          type: "custom_tool_call",
          call_id: "call-1",
          namespace: "functions",
          name: "apply_patch",
          input: "*** Begin Patch",
        },
      ],
    });
  });

  test("seals the credential-proven owner and durable thread with native call aliases", async ({
    makeAgent,
  }) => {
    config.llmProxy.appaHook = {
      url: runtimeUrl,
      timeoutMs: 100,
      sessionHmacSecret: "native-bridge-session-secret".repeat(3),
    };
    const agent = await makeAgent();
    const clientSessionId = `thread-${randomUUID()}`;
    const session = await AppaProxyHookSession.acquire({
      config: config.llmProxy.appaHook,
      profileId: agent.id,
      ownerScopeHash: `native-bridge-owner-${randomUUID()}`,
      clientSessionId,
      toolResults: [],
    });
    const prepared = await prepareNativeCodexCallAliases({
      session,
      principalUserId: "credential-proven-user",
      gatewayPrincipals: new Map([
        [
          "mcp__appa_gateway",
          {
            principalUserId: "credential-proven-user",
            gatewayProfileId: "gateway-profile",
          },
        ],
      ]),
      request: { model: "gpt-test" },
      response: {
        output: [
          {
            id: "provider-item",
            type: "function_call",
            call_id: "provider-call",
            namespace: "mcp__appa_gateway",
            name: "archestra__run_tool",
            arguments:
              '{"tool_name":"fixture__create_job","tool_args":{"value":"exact"}}',
          },
        ],
      },
      calls: [
        {
          id: "provider-call",
          name: "mcp__appa_gateway__archestra__run_tool",
          arguments:
            '{"tool_name":"fixture__create_job","tool_args":{"value":"exact"}}',
        },
      ],
    });
    const held = await AppaProxyWireModel.findOwned({
      ...session.getNativeWireScope(),
      frameId: prepared.frameId,
    });
    expect(JSON.parse(prepared.calls[0]?.arguments ?? "{}")).toEqual({
      tool_name: "fixture__create_job",
      tool_args: { value: "exact" },
      wire_context: {
        call_id: prepared.calls[0]?.id,
        thread_id: clientSessionId,
        item_id: `fc_${prepared.calls[0]?.id}`,
      },
    });
    expect(prepared.calls[0]?.name).toBe(
      "mcp__appa_gateway__archestra__run_tool",
    );
    const payload = held?.payload;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("native response frame is unavailable");
    }
    const heldPayload = payload as Record<string, unknown> & {
      calls: Array<Record<string, unknown>>;
    };
    if (!Array.isArray(heldPayload.calls)) {
      throw new Error("native response frame is unavailable");
    }
    await AppaProxyWireModel.replaceHeldPayload({
      ...session.getNativeWireScope(),
      frameId: prepared.frameId,
      payload: {
        ...heldPayload,
        // This emulates a server-side rewrite before normal publication. The
        // finalizer must bind this value rather than the original proposal.
        calls: heldPayload.calls.map((call) => {
          if (call.id !== prepared.calls[0]?.id) return call;
          const wrapper = JSON.parse(call.arguments as string);
          return {
            ...call,
            arguments: JSON.stringify({
              ...wrapper,
              tool_args: { value: "rewritten" },
            }),
          };
        }),
      },
    });
    await issueNativeCodexFrame({ session, frameId: prepared.frameId });
    const aliases = await AppaProxyWireModel.listIssuedAliases(
      session.getNativeWireScope(),
    );
    const alias = aliases.find(
      (entry) => entry.wireId === prepared.calls[0]?.id,
    );
    expect(alias).toMatchObject({
      wireId: prepared.calls[0]?.id,
      metadata: {
        purpose: "native_call",
        principalUserId: "credential-proven-user",
        threadId: clientSessionId,
        itemId: `fc_${prepared.calls[0]?.id}`,
        toolName: "fixture__create_job",
        argumentsCanonical: '{"value":"rewritten"}',
      },
    });
    const executionArguments = JSON.parse(
      String(
        (
          alias?.metadata as
            | { executionArgumentsCanonical?: unknown }
            | undefined
        )?.executionArgumentsCanonical,
      ),
    );
    await expect(
      restoreNativeCodexProviderIds({
        session,
        request: {
          input: [
            {
              type: "mcp_tool_call",
              tool: "archestra__run_tool",
              arguments: executionArguments,
            },
          ],
        },
      }),
    ).resolves.toMatchObject({
      input: [
        {
          type: "function_call",
          call_id: "provider-call",
          namespace: "mcp__appa_gateway",
          name: "archestra__run_tool",
        },
      ],
    });
    await expect(
      AppaProxyWireModel.claimNativeMcpExecution({
        ...session.getNativeWireScope(),
        aliasId: alias?.id ?? "",
        callId: prepared.calls[0]?.id ?? "",
        expectedExecutionArgumentsCanonical: '{"value":"exact"}',
      }),
    ).rejects.toThrow("binding changed");
    await expect(
      AppaProxyWireModel.finalizeNativeMcpBindingsAndMarkReady({
        ...session.getNativeWireScope(),
        frameId: prepared.frameId,
      }),
    ).rejects.toThrow("cannot become ready twice");
  });

  test("fails closed for concurrent native tool-call batches", async ({
    makeAgent,
  }) => {
    config.llmProxy.appaHook = nativeHookConfig();
    const agent = await makeAgent();
    const session = await AppaProxyHookSession.acquire({
      config: nativeHookConfig(),
      profileId: agent.id,
      ownerScopeHash: `native-bridge-owner-${randomUUID()}`,
      clientSessionId: `native-bridge-thread-${randomUUID()}`,
      toolResults: [],
    });

    await expect(
      prepareNativeCodexCallAliases({
        session,
        request: { model: "gpt-test" },
        response: {
          output: [
            {
              id: "fc_first",
              type: "function_call",
              call_id: "call_first",
              name: "first",
              arguments: "{}",
            },
            {
              id: "fc_second",
              type: "function_call",
              call_id: "call_second",
              name: "second",
              arguments: "{}",
            },
          ],
        },
        calls: [
          { id: "call_first", name: "first", arguments: "{}" },
          { id: "call_second", name: "second", arguments: "{}" },
        ],
      }),
    ).rejects.toThrow("Concurrent native tool-call batches are unsupported");
  });

  test("projects fixture tools only from a discovered branded gateway namespace", async ({
    makeAgent,
  }) => {
    config.llmProxy.appaHook = {
      url: runtimeUrl,
      timeoutMs: 100,
      runtimeToken: "native-bridge-runtime-token",
      sessionHmacSecret: "native-bridge-session-secret".repeat(3),
    };
    server.use(
      http.get(`${runtimeUrl}/proxy/v1/capabilities`, () =>
        HttpResponse.json({
          protocol_version: 1,
          legacy_hooks: false,
          completed_event_replay: true,
          typed_offers: true,
          restriction_acceptance: true,
          human_approval: false,
          sanitized_results: true,
          child_workflows: false,
        }),
      ),
      http.post(`${runtimeUrl}/proxy/v1/events`, async ({ request }) => {
        const requestBody = await request.text();
        const envelope = JSON.parse(requestBody) as { event_id: string };
        return HttpResponse.json({
          protocol_version: 1,
          event_id: envelope.event_id,
          request_sha256: createHash("sha256")
            .update(requestBody)
            .digest("hex"),
          decision: { decision: "ack" },
        });
      }),
    );
    const agent = await makeAgent();
    const session = await AppaProxyHookSession.open({
      config: {
        url: runtimeUrl,
        timeoutMs: 100,
        runtimeToken: "native-bridge-runtime-token",
        sessionHmacSecret: "native-bridge-session-secret".repeat(3),
      },
      profileId: agent.id,
      ownerScopeHash: `native-bridge-owner-${randomUUID()}`,
      clientSessionId: `native-bridge-thread-${randomUUID()}`,
      modelInput: { input: "bootstrap" },
      toolResults: [],
    });
    const initialRequest = {
      model: "gpt-test",
      input: [
        {
          type: "additional_tools",
          tools: [
            {
              type: "namespace",
              name: "functions",
              tools: [{ type: "custom", name: "exec" }],
            },
          ],
        },
      ],
    };
    await expect(
      recordNativeCodexDiscovery({ session, request: initialRequest }),
    ).resolves.toBeNull();
    const bootstrap = await createNativeCodexBootstrap({
      session,
      request: initialRequest,
    });
    const bootstrapCallId = String(
      (bootstrap.output as Array<Record<string, unknown>>)[0]?.call_id,
    );
    const registry = await recordNativeCodexDiscovery({
      session,
      request: {
        ...initialRequest,
        input: [
          ...initialRequest.input,
          {
            type: "custom_tool_call_output",
            call_id: bootstrapCallId,
            output: [
              {
                type: "input_text",
                text: JSON.stringify([
                  "mcp__fixture__archestra__run_tool",
                  "mcp__fixture__write_fixture",
                  "mcp__other__read_outside_fixture",
                ]),
              },
            ],
          },
        ],
      },
    });
    expect(registry).toEqual([
      {
        namespace: "mcp__fixture",
        name: "archestra__run_tool",
        kind: "function",
      },
      {
        namespace: "mcp__fixture",
        name: "write_fixture",
        kind: "function",
      },
    ]);
  });

  test("removes exact completed gateway controls from full history and rejects unowned control text", async ({
    makeAgent,
  }) => {
    config.llmProxy.appaHook = nativeHookConfig();
    installNativeRuntime();
    const agent = await makeAgent();
    const session = await AppaProxyHookSession.open({
      config: nativeHookConfig(),
      profileId: agent.id,
      ownerScopeHash: `native-bridge-owner-${randomUUID()}`,
      clientSessionId: `native-bridge-thread-${randomUUID()}`,
      modelInput: { input: "completed control history" },
      toolResults: [],
    });
    const controlCallId = await createCompletedNativeControl(session);
    const controlCall = {
      id: `fc_${controlCallId}`,
      type: "function_call",
      call_id: controlCallId,
      namespace: "mcp__gateway",
      name: "archestra__appa_execute_remedy",
      arguments: '{"intent_id":"client-supplied-text"}',
    };
    const controlOutput = {
      type: "function_call_output",
      call_id: controlCallId,
      output: "client-supplied-control-result",
    };
    const projected = await projectNativeCodexModelRequest({
      session,
      registry: [],
      request: {
        input: [
          controlCall,
          controlOutput,
          { type: "input_text", text: "continue with safe history" },
        ],
      },
    });
    expect(projected.input).toEqual([
      { type: "input_text", text: "continue with safe history" },
    ]);

    await expect(
      projectNativeCodexModelRequest({
        session,
        registry: [],
        request: {
          input: [
            {
              ...controlCall,
              call_id: "call_client_control",
              arguments: '{"intent_id":"unowned-client-text"}',
            },
          ],
        },
      }),
    ).rejects.toThrow("completed owned receipt");
  });

  test("restores issued custom history from its encrypted response frame", async ({
    makeAgent,
  }) => {
    config.llmProxy.appaHook = nativeHookConfig();
    const agent = await makeAgent();
    const session = await AppaProxyHookSession.acquire({
      config: nativeHookConfig(),
      profileId: agent.id,
      ownerScopeHash: `native-bridge-owner-${randomUUID()}`,
      clientSessionId: `native-bridge-thread-${randomUUID()}`,
      toolResults: [],
    });
    const providerItem = {
      id: "ctc_provider_patch",
      type: "custom_tool_call",
      call_id: "call_provider_patch",
      namespace: "functions",
      name: "apply_patch",
      input: "*** Begin Patch\n*** End Patch",
      provider_extension: { opaque: "authoritative" },
    };
    const prepared = await prepareNativeCodexCallAliases({
      session,
      request: { model: "gpt-test" },
      response: { output: [providerItem] },
      calls: [
        {
          id: providerItem.call_id,
          name: "functions.apply_patch",
          arguments: '{"input":"*** Begin Patch\\n*** End Patch"}',
        },
      ],
    });
    await issueNativeCodexFrame({ session, frameId: prepared.frameId });
    const clientCallId = prepared.calls[0]?.id;
    if (!clientCallId) throw new Error("native custom call was not allocated");
    const request = {
      input: [
        {
          ...providerItem,
          id: "ctc_client_forged",
          call_id: clientCallId,
          input: "forged client input",
          provider_extension: { opaque: "forged" },
        },
        {
          type: "custom_tool_call_output",
          call_id: clientCallId,
          output: "client tool result",
          provider_extension: { preserve: true },
        },
        {
          type: "agent_message",
          author: "worker-a",
          recipient: "worker-b",
          content: "continue",
        },
      ],
    };

    const projected = await projectNativeCodexModelRequest({
      session,
      request,
      registry: [],
    });
    expect(projected.input).toEqual([
      providerItem,
      {
        type: "custom_tool_call_output",
        call_id: providerItem.call_id,
        output: "client tool result",
        provider_extension: { preserve: true },
      },
      {
        type: "agent_message",
        author: "worker-a",
        recipient: "worker-b",
        content: "continue",
      },
    ]);
    await expect(
      restoreNativeCodexProviderIds({ session, request: projected }),
    ).resolves.toMatchObject({ input: projected.input });
    await expect(
      projectNativeCodexModelRequest({
        session,
        registry: [],
        request: {
          input: [
            {
              ...providerItem,
              call_id: "call_unknown_custom",
            },
          ],
        },
      }),
    ).rejects.toThrow("issued wire binding");
  });

  test("issues and atomically admits only the exact authenticated tool-search continuation", async ({
    makeAgent,
  }) => {
    config.llmProxy.appaHook = nativeHookConfig();
    const agent = await makeAgent();
    const ownerScopeHash = `native-search-owner-${randomUUID()}`;
    const threadId = `native-search-thread-${randomUUID()}`;
    const owner = "native-search-user";
    const session = await AppaProxyHookSession.acquire({
      config: nativeHookConfig(),
      profileId: agent.id,
      ownerScopeHash,
      clientSessionId: threadId,
      toolResults: [],
    });
    const searchCall = {
      id: "tsc_provider_search",
      type: "tool_search_call" as const,
      call_id: "call_provider_search",
      execution: "client" as const,
      arguments: { query: "declared gateway tools" },
      provider_extension: { preserve: "provider-wire" },
    };
    const prepared = await prepareNativeCodexCallAliases({
      session,
      principalUserId: owner,
      request: stockResponsesRequest(),
      response: { output: [searchCall] },
      calls: [],
    });
    await issueNativeCodexFrame({ session, frameId: prepared.frameId });

    const searchOutput = {
      type: "tool_search_output",
      id: "tso_provider_search",
      call_id: searchCall.call_id,
      execution: "client",
      status: "completed",
      // Exact anonymized stock-Codex receipt shape. The gateway server name is
      // a namespace wrapper and its functions sit one level deeper.
      tools: [
        {
          name: "mcp__my_gateway",
          description: "Configured gateway tools.",
          tools: [
            {
              type: "function",
              name: "archestra__run_tool",
              description: "Run a gateway tool by name.",
              strict: false,
              defer_loading: false,
              parameters: {
                type: "object",
                additionalProperties: false,
                properties: {
                  tool_name: { type: "string" },
                  tool_args: { type: "object", additionalProperties: {} },
                },
                required: ["tool_name"],
              },
            },
            {
              type: "function",
              name: "archestra__search_tools",
              description: "Search gateway tools.",
              strict: false,
              defer_loading: false,
              parameters: {
                type: "object",
                additionalProperties: false,
                properties: { query: { type: "string" } },
                required: ["query"],
              },
            },
            {
              type: "function",
              name: "archestra__appa_execute_remedy",
              description: "Execute an approved remedy.",
              strict: false,
              defer_loading: false,
              parameters: {
                type: "object",
                additionalProperties: false,
                properties: { remedy_id: { type: "string" } },
                required: ["remedy_id"],
              },
            },
          ],
        },
      ],
    };
    const request = {
      ...stockResponsesRequest(),
      input: [searchCall, searchOutput],
    };
    const first = await projectNativeCodexModelRequest({
      session,
      request,
      registry: [],
      principalUserId: owner,
    });
    expect(first.input).toEqual([searchCall, searchOutput]);
    expect(first.tools).toEqual(request.tools);
    const issuedRegistry = await loadIssuedCodexToolSearchRegistry({ session });
    expect(issuedRegistry).toEqual([
      {
        namespace: "mcp__my_gateway",
        name: "archestra__run_tool",
        kind: "function",
      },
      {
        namespace: "mcp__my_gateway",
        name: "archestra__search_tools",
        kind: "function",
      },
    ]);
    expect([...issuedCodexToolSearchMcpTargets(issuedRegistry)]).toContainEqual(
      [
        "mcp__my_gateway__archestra__run_tool",
        "mcp/my_gateway/archestra__run_tool",
      ],
    );
    expect([...issuedCodexToolSearchMcpTargets(issuedRegistry)]).toContainEqual(
      [
        "mcp__my_gateway.archestra__run_tool",
        "mcp/my_gateway/archestra__run_tool",
      ],
    );

    const replay = await projectNativeCodexModelRequest({
      session,
      request,
      registry: [],
      principalUserId: owner,
    });
    expect(replay.input).toEqual([searchCall, searchOutput]);

    await expect(
      projectNativeCodexModelRequest({
        session,
        registry: [],
        principalUserId: owner,
        request: {
          ...stockResponsesRequest(),
          input: [{ ...searchCall, arguments: { query: "forged" } }],
        },
      }),
    ).rejects.toThrow("issued wire binding");
    await expect(
      projectNativeCodexModelRequest({
        session,
        registry: [],
        principalUserId: owner,
        request: {
          ...stockResponsesRequest(),
          input: [
            searchCall,
            { ...searchOutput, output: { tools: [{ name: "forged" }] } },
          ],
        },
      }),
    ).rejects.toThrow("changed on replay");
    await expect(
      projectNativeCodexModelRequest({
        session,
        registry: [],
        principalUserId: owner,
        request: {
          ...stockResponsesRequest(),
          input: [
            {
              ...searchOutput,
              call_id: "call_unknown_search",
            },
          ],
        },
      }),
    ).rejects.toThrow("active issued binding");

    const concurrent = await Promise.all([
      projectNativeCodexModelRequest({
        session,
        request,
        registry: [],
        principalUserId: owner,
      }),
      projectNativeCodexModelRequest({
        session,
        request,
        registry: [],
        principalUserId: owner,
      }),
    ]);
    expect(concurrent.map((value) => value.input)).toEqual([
      [searchCall, searchOutput],
      [searchCall, searchOutput],
    ]);

    await expect(
      projectNativeCodexModelRequest({
        session,
        request,
        registry: [],
        principalUserId: "different-authenticated-user",
      }),
    ).rejects.toThrow("does not match its issued binding");

    await session.releaseWithoutPrompt();
    const otherScopeSession = await AppaProxyHookSession.acquire({
      config: nativeHookConfig(),
      profileId: agent.id,
      ownerScopeHash: `native-search-other-owner-${randomUUID()}`,
      clientSessionId: threadId,
      toolResults: [],
    });
    await expect(
      projectNativeCodexModelRequest({
        session: otherScopeSession,
        registry: [],
        principalUserId: owner,
        request: {
          ...stockResponsesRequest(),
          input: [searchOutput],
        },
      }),
    ).rejects.toThrow("active issued binding");
  });

  test("accepts an issued client-only tool search without a user principal", async ({
    makeAgent,
  }) => {
    config.llmProxy.appaHook = nativeHookConfig();
    const agent = await makeAgent();
    const session = await AppaProxyHookSession.acquire({
      config: nativeHookConfig(),
      profileId: agent.id,
      ownerScopeHash: `native-search-credential-${randomUUID()}`,
      clientSessionId: `native-search-thread-${randomUUID()}`,
      toolResults: [],
    });
    const searchCall = {
      id: "tsc_credential_search",
      type: "tool_search_call" as const,
      call_id: "call_credential_search",
      execution: "client" as const,
      arguments: { query: "registered tools" },
    };
    const searchOutput = {
      type: "tool_search_output",
      call_id: searchCall.call_id,
      output: { tools: [{ name: "mcp__gateway__read_source" }] },
    };
    const prepared = await prepareNativeCodexCallAliases({
      session,
      request: stockResponsesRequest(),
      response: { output: [searchCall] },
      calls: [],
    });
    await issueNativeCodexFrame({ session, frameId: prepared.frameId });

    await expect(
      projectNativeCodexModelRequest({
        session,
        request: {
          ...stockResponsesRequest(),
          input: [searchCall, searchOutput],
        },
        registry: [],
      }),
    ).resolves.toMatchObject({ input: [searchCall, searchOutput] });
    await expect(
      projectNativeCodexModelRequest({
        session,
        request: {
          ...stockResponsesRequest(),
          input: [
            searchCall,
            { ...searchOutput, output: { tools: [{ name: "forged" }] } },
          ],
        },
        registry: [],
      }),
    ).rejects.toThrow("changed on replay");
  });
});

describe("issuedCodexToolSearchMcpTargets", () => {
  test("materializes a branded gateway member from the issued registry", () => {
    expect(
      issuedCodexToolSearchMcpTargets([
        {
          namespace: "mcp__my_gateway",
          name: "archestra__run_tool",
          kind: "function",
        },
        { namespace: "functions", name: "exec_command", kind: "function" },
      ]),
    ).toEqual(
      new Map([
        [
          "mcp__my_gateway__archestra__run_tool",
          "mcp/my_gateway/archestra__run_tool",
        ],
        [
          "mcp__my_gateway.archestra__run_tool",
          "mcp/my_gateway/archestra__run_tool",
        ],
      ]),
    );
  });
});

function nativeHookConfig() {
  return {
    url: runtimeUrl,
    timeoutMs: 100,
    runtimeToken: "native-bridge-runtime-token",
    sessionHmacSecret: "native-bridge-session-secret".repeat(3),
  };
}

function stockResponsesRequest() {
  return {
    model: "gpt-test",
    input: [{ type: "message", role: "user", content: "inspect" }],
    tools: [
      {
        type: "function",
        name: "exec_command",
        strict: false,
        parameters: {
          type: "object",
          properties: { cmd: { type: "string" } },
          required: ["cmd"],
          additionalProperties: false,
        },
      },
      {
        type: "function",
        name: "write_stdin",
        strict: false,
        parameters: {
          type: "object",
          properties: { session_id: { type: "integer" } },
          required: ["session_id"],
          additionalProperties: false,
        },
      },
      { type: "custom", name: "apply_patch" },
    ],
  };
}

function installNativeRuntime() {
  server.use(
    http.get(`${runtimeUrl}/proxy/v1/capabilities`, () =>
      HttpResponse.json({
        protocol_version: 1,
        legacy_hooks: false,
        completed_event_replay: true,
        typed_offers: true,
        restriction_acceptance: true,
        human_approval: false,
        sanitized_results: true,
        child_workflows: false,
      }),
    ),
    http.post(`${runtimeUrl}/proxy/v1/events`, async ({ request }) => {
      const requestBody = await request.text();
      const envelope = JSON.parse(requestBody) as { event_id: string };
      return HttpResponse.json({
        protocol_version: 1,
        event_id: envelope.event_id,
        request_sha256: createHash("sha256").update(requestBody).digest("hex"),
        decision: { decision: "ack" },
      });
    }),
  );
}

async function createCompletedNativeControl(session: AppaProxyHookSession) {
  const scope = session.getNativeWireScope();
  const parent = await AppaProxyWireModel.createFrame({
    ...scope,
    kind: "model_response",
    protocol: "codex-native-response/v1",
    requestHash: "native-control-parent",
    idempotencyKey: `native-control-parent:${scope.turnId}`,
    payload: { response: { output: [] } },
    expiresAt: new Date(Date.now() + 60_000),
  });
  const controlCallId = `call_appa_control_${randomUUID().replaceAll("-", "")}`;
  const batchId = randomUUID();
  const control = await AppaProxyWireModel.createFrame({
    ...scope,
    kind: "remedy_control",
    protocol: "codex-native-held-remedy/v1",
    requestHash: "native-control",
    idempotencyKey: `native-control:${controlCallId}`,
    parentFrameId: parent.id,
    runtimeBatchId: batchId,
    controlCallId,
    payload: {
      version: 1,
      purpose: "gateway_remedy",
      type: "remedy_batch",
      intent: { id: parent.id, descriptor: "native test control" },
      rootId: session.rootId,
      heldParentFrameId: parent.id,
      controlNamespace: "mcp__gateway",
      boundThreadId: "native-bridge-thread",
      owner: { kind: "user", id: "native-bridge-user" },
      vouch: { operation: "execute", chosenRemedyId: "offer-0" },
      offers: [
        {
          id: "offer-0",
          batchId,
          position: 0,
          callId: "business-call-0",
          kind: "acceptance",
          tool: "weather_lookup",
          argumentsSha256: "0".repeat(64),
          effectiveArguments: {},
        },
      ],
    },
    expiresAt: new Date(Date.now() + 60_000),
  });
  await AppaProxyWireModel.markReady({ ...scope, frameId: control.id });
  await AppaProxyWireModel.markIssued({ ...scope, frameId: control.id });
  const execution = await AppaProxyWireModel.beginControlExecution({
    ...scope,
    frameId: control.id,
    selection: { test: true },
  });
  if (!execution.acquired)
    throw new Error("control execution was not acquired");
  await AppaProxyWireModel.completeControl({
    ...scope,
    frameId: control.id,
    receipt: { source: "trusted-test" },
  });
  await AppaProxyWireModel.markReady({ ...scope, frameId: parent.id });
  await AppaProxyWireModel.markIssued({ ...scope, frameId: parent.id });
  return controlCallId;
}
