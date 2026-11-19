import { randomUUID } from "node:crypto";
import { describe, expect, test } from "vitest";
import { attestToolDescription } from "@/archestra-mcp-server/tool-attestation";
import { grokToolName } from "@/routes/mcp-gateway/grok-tool-names";
import { normalizeToolCallsForPolicy } from "@/routes/proxy/llm-proxy-helpers";
import { extractGatewayToolDeclarations } from "./gateway-tool-declarations";
import { resolveGatewayToolIdentity } from "./gateway-tool-names";
import { GrokDeferredTools } from "./grok-deferred-tools";

const organizationId = randomUUID();
const gatewayId = randomUUID();
const target = "gateway__archestra__execute_remedy_plan";
const schema = { type: "object", properties: { offer_id: { type: "string" } } };

function discovered(overrides: Record<string, unknown> = {}) {
  return {
    tool_name: target,
    description: attestToolDescription({
      organizationId,
      gatewayId,
      advertisedName: "archestra__execute_remedy_plan",
      kind: "b",
      description: "Apply the exact remedy",
    }),
    input_schema: schema,
    ...overrides,
  };
}

function request(tools: Record<string, unknown>[] = [discovered()]) {
  return {
    tools: [
      {
        type: "function",
        function: { name: "use_tool", parameters: { type: "object" } },
      },
      {
        type: "function",
        function: { name: "search_tool", parameters: { type: "object" } },
      },
    ],
    messages: [
      {
        role: "assistant",
        tool_calls: [
          {
            id: "search",
            type: "function",
            function: {
              name: "search_tool",
              arguments: '{"query":"gateway remedy"}',
            },
          },
        ],
      },
      {
        role: "tool",
        tool_call_id: "search",
        content: JSON.stringify({
          results: [{ server: "gateway", tools }],
          status: "ready",
          total_hidden_tools: tools.length,
          note: null,
        }),
      },
      {
        role: "assistant",
        tool_calls: [
          {
            id: "execute",
            type: "function",
            function: {
              name: "use_tool",
              arguments: JSON.stringify({
                tool_name: target,
                tool_input: { offer_id: "synthetic" },
              }),
            },
          },
        ],
      },
    ],
  };
}

function platformTool(
  name: string,
  options: { gatewayId?: string; server?: string } = {},
) {
  return {
    tool_name: `${options.server ?? "gateway"}__${grokToolName(name)}`,
    description: attestToolDescription({
      organizationId,
      gatewayId: options.gatewayId ?? gatewayId,
      advertisedName: name,
      kind: "b",
      description: "Synthetic gateway capability",
    }),
    input_schema: { type: "object", properties: {} },
  };
}

async function boundTransport(
  body: Record<string, unknown>,
  org = organizationId,
  interactionType = "xai:chatCompletions",
) {
  const transport = new GrokDeferredTools(body);
  const declarations = extractGatewayToolDeclarations(body);
  declarations.push(
    ...transport.prepare({
      organizationId: org,
      interactionType,
      body,
    }),
  );
  const identity = await resolveGatewayToolIdentity({
    organizationId: org,
    declarations,
    internalChat: false,
  });
  transport.bindIdentity(identity);
  return { transport, identity };
}

describe("Grok signed deferred gateway transport", () => {
  test.each([
    "archestra__execute_remedy_plan",
    "archestra__get_remedy_plans",
    "archestra__ask_user",
  ])("discovers the incomplete remedy pair before dispatching %s", async (name) => {
    const entry = platformTool(name);
    const args = { label: {} };
    const call = {
      id: "partial-control",
      name: "use_tool",
      arguments: JSON.stringify({
        tool_name: entry.tool_name,
        tool_input: args,
      }),
    };
    const { transport } = await boundTransport(request([entry]));
    const [search] = transport.unwrapCalls([call]);
    expect(search).toMatchObject({ id: call.id, name: "search_tool" });
    expect(transport.wrapCalls([search])).toEqual([search]);
    // A duplicate in the same batch cannot trigger another discovery.
    expect(transport.unwrapCalls([call])[0].name).toBe(entry.tool_name);
    const query = JSON.parse(search.arguments).query;
    const failedBody = request([entry]);
    const priorSearch = failedBody.messages[0].tool_calls?.[0];
    if (!priorSearch) throw new Error("Missing synthetic lookup");
    priorSearch.function.arguments = JSON.stringify({
      query,
    });
    const failed = await boundTransport(failedBody);
    expect(failed.transport.unwrapCalls([call])[0].name).toBe(entry.tool_name);
    const complete = await boundTransport(
      request([
        platformTool("archestra__execute_remedy_plan"),
        platformTool("archestra__get_remedy_plans"),
        ...(name.endsWith("ask_user") ? [entry] : []),
      ]),
    );
    const [resolved] = complete.transport.unwrapCalls([call]);
    expect(resolved).toEqual({
      id: call.id,
      name: entry.tool_name,
      arguments: JSON.stringify(args),
    });
    expect(complete.transport.wrapCalls([resolved])).toEqual([call]);
  });

  test.each([
    "chat",
    "responses",
    "messages",
  ])("%s permits rediscovery in a new user turn but not after a failed lookup or synthetic reminder", (wire) => {
    const query = "gateway remedy";
    const search = {
      name: "search_tool",
      arguments: JSON.stringify({ query }),
    };
    const tools = ["search_tool", "use_tool"].map((name) =>
      wire === "chat"
        ? { type: "function", function: { name, parameters: {} } }
        : wire === "responses"
          ? { type: "function", name, parameters: {} }
          : { name, input_schema: {} },
    );
    const lookup =
      wire === "responses"
        ? [
            {
              type: "function_call",
              name: "search_tool",
              call_id: "lookup",
              arguments: search.arguments,
            },
            {
              type: "function_call_output",
              call_id: "lookup",
              output: '{"results":[],"status":"partial"}',
            },
          ]
        : wire === "messages"
          ? [
              {
                role: "assistant",
                content: [
                  {
                    type: "tool_use",
                    id: "lookup",
                    name: "search_tool",
                    input: { query },
                  },
                ],
              },
              {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    tool_use_id: "lookup",
                    content: '{"results":[],"status":"partial"}',
                  },
                ],
              },
            ]
          : [
              {
                role: "assistant",
                tool_calls: [
                  {
                    id: "lookup",
                    type: "function",
                    function: search,
                  },
                ],
              },
              {
                role: "tool",
                tool_call_id: "lookup",
                content: '{"results":[],"status":"partial"}',
              },
            ];
    const body = (history: unknown[]) => ({
      tools,
      [wire === "responses" ? "input" : "messages"]: history,
    });
    const previous = [{ role: "user", content: "Earlier task" }, ...lookup];
    expect(new GrokDeferredTools(body(previous)).recoverySearch(search)).toBe(
      false,
    );
    const next = [
      ...previous,
      { role: "user", content: "A new task after the catalog was lost" },
    ];
    const transport = new GrokDeferredTools(body(next));
    expect(transport.recoverySearch(search)).toBe(true);
    expect(transport.recoverySearch(search)).toBe(false);
    expect(
      new GrokDeferredTools(
        body([
          ...next,
          ...lookup,
          {
            role: "user",
            content:
              "<system-reminder>\nMCP servers are still connecting.\n</system-reminder>",
          },
        ]),
      ).recoverySearch(search),
    ).toBe(false);
    // A provider-thread delta cannot pretend to be a new user turn.
    expect(
      new GrokDeferredTools(body(lookup.slice(-1))).recoverySearch(search),
    ).toBeUndefined();
  });

  test("encoded MCP names retain exact signed canonical identity; fabricated or foreign nested encoded targets cannot gain authority", async () => {
    const encoded = `gateway__${grokToolName("archestra__execute_remedy_plan")}`;
    const body = request([discovered({ tool_name: encoded })]);
    const bridge = new GrokDeferredTools(body);
    const declarations = bridge.prepare({
      organizationId,
      interactionType: "openai:chatCompletions",
      body,
    });
    const identity = await resolveGatewayToolIdentity({
      organizationId,
      declarations,
      internalChat: false,
    });
    expect(identity.canonicalize(encoded)).toBe(
      "archestra__execute_remedy_plan",
    );
    const call = {
      id: "encoded",
      name: "use_tool",
      arguments: JSON.stringify({
        tool_name: encoded,
        tool_input: { offer_id: "exact" },
      }),
    };
    expect(bridge.wrapCalls(bridge.unwrapCalls([call]))).toEqual([call]);
    const forged = request([
      discovered({
        tool_name: `gateway__${grokToolName("archestra__ask_user")}`,
      }),
    ]);
    expect(
      new GrokDeferredTools(forged).prepare({
        organizationId,
        interactionType: "openai:chatCompletions",
        body: forged,
      }),
    ).toEqual([]);
    const nestedName = "provider__run_tool";
    const nested = request([
      discovered({
        tool_name: `gateway__${grokToolName(nestedName)}`,
        description: attestToolDescription({
          organizationId,
          gatewayId,
          advertisedName: nestedName,
          kind: "t",
          description: "Synthetic nested dispatcher",
        }),
      }),
    ]);
    expect(
      new GrokDeferredTools(nested).prepare({
        organizationId,
        interactionType: "openai:chatCompletions",
        body: nested,
      }),
    ).toEqual([]);
  });

  test("the verified gateway dispatcher carries progressive targets through native use_tool with exact policy arguments", async () => {
    const run = platformTool("archestra__run_tool");
    const search = platformTool("archestra__search_tools");
    const { transport, identity } = await boundTransport(
      request([run, search]),
    );
    const targetName = "archestra__list_skills";
    const args = { limit: 3, query: "two words 日本語" };
    const mistaken = {
      id: "progressive-target",
      name: "use_tool",
      arguments: JSON.stringify({ tool_name: targetName, tool_input: args }),
    };
    const [internal] = transport.unwrapCalls([mistaken]);
    expect(internal).toEqual({
      id: mistaken.id,
      name: run.tool_name,
      arguments: JSON.stringify({ tool_name: targetName, tool_args: args }),
    });
    expect(normalizeToolCallsForPolicy([internal], identity)).toEqual([
      {
        toolCallName: targetName,
        toolCallArgs: JSON.stringify(args),
        isRunToolDispatchTarget: true,
      },
    ]);
    const corrected = {
      ...mistaken,
      arguments: JSON.stringify({
        tool_name: run.tool_name,
        tool_input: { tool_name: targetName, tool_args: args },
      }),
    };
    expect(transport.wrapCalls([internal])).toEqual([corrected]);
    expect(transport.unwrapCalls([corrected])).toEqual([internal]);
  });

  test("a canonical name uses its unique verified catalog entry directly when one exists", async () => {
    const entry = platformTool("archestra__list_skills");
    const { transport, identity } = await boundTransport(request([entry]));
    const original = {
      id: "canonical-name",
      name: "use_tool",
      arguments:
        '{"tool_name":"archestra__list_skills","tool_input":{"limit":3}}',
    };
    const calls = transport.unwrapCalls([original]);
    expect(calls).toEqual([
      {
        id: original.id,
        name: entry.tool_name,
        arguments: '{"limit":3}',
      },
    ]);
    expect(normalizeToolCallsForPolicy(calls, identity)).toEqual([
      {
        toolCallName: "archestra__list_skills",
        toolCallArgs: '{"limit":3}',
      },
    ]);
    expect(transport.wrapCalls(calls)[0]).toEqual({
      ...original,
      arguments: JSON.stringify({
        tool_name: entry.tool_name,
        tool_input: { limit: 3 },
      }),
    });
  });

  test.each([
    "no-search",
    "wrong-org",
    "different-gateways",
    "conflicting-declaration",
    "replayed-alias",
  ])("does not repair a progressive target with %s dispatcher evidence", async (mode) => {
    const run = platformTool("archestra__run_tool");
    const search = platformTool("archestra__search_tools", {
      gatewayId: mode === "different-gateways" ? randomUUID() : gatewayId,
    });
    const body = request(mode === "no-search" ? [run] : [run, search]);

    if (mode === "conflicting-declaration")
      body.tools.push({
        type: "function",
        function: { name: run.tool_name, parameters: { type: "string" } },
      });
    if (mode === "replayed-alias") {
      const result = JSON.parse(body.messages[1].content as string);
      result.results.push({
        server: "foreign",
        tools: [platformTool("archestra__run_tool", { server: "foreign" })],
      });
      body.messages[1].content = JSON.stringify(result);
    }
    const { transport } = await boundTransport(
      body,
      mode === "wrong-org" ? randomUUID() : organizationId,
    );
    const call = {
      id: "unproven",
      name: "use_tool",
      arguments: '{"tool_name":"archestra__list_skills","tool_input":{}}',
    };
    expect(transport.unwrapCalls([call])).toEqual([call]);
  });

  test.each([
    "chat",
    "responses",
    "messages",
  ])("%s loads a missing dispatcher once through native discovery while withholding the requested target", async (wire) => {
    const entry = platformTool("archestra__search_tools");
    const query = "gateway run_tool search_tools";
    const makeBody = (searchedQuery: string) => {
      const result = JSON.stringify({
        results: [{ server: "gateway", tools: [entry] }],
      });
      if (wire === "responses")
        return {
          tools: ["search_tool", "use_tool"].map((name) => ({
            type: "function",
            name,
            parameters: {},
          })),
          input: [
            {
              type: "function_call",
              call_id: "catalog",
              name: "search_tool",
              arguments: JSON.stringify({ query: searchedQuery }),
            },
            {
              type: "function_call_output",
              call_id: "catalog",
              output: result,
            },
          ],
        };
      if (wire === "messages")
        return {
          tools: ["search_tool", "use_tool"].map((name) => ({
            name,
            input_schema: {},
          })),
          messages: [
            {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "catalog",
                  name: "search_tool",
                  input: { query: searchedQuery },
                },
              ],
            },
            {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: "catalog",
                  content: result,
                },
              ],
            },
          ],
        };
      const body = request([entry]);
      const call = body.messages[0].tool_calls?.[0];
      if (!call) throw new Error("Missing synthetic catalog call");
      call.function.arguments = JSON.stringify({
        query: searchedQuery,
      });
      return body;
    };
    const interactionType =
      wire === "responses"
        ? "xai:responses"
        : wire === "messages"
          ? "anthropic:messages"
          : "xai:chatCompletions";
    const { transport } = await boundTransport(
      makeBody("gateway"),
      organizationId,
      interactionType,
    );
    const original = {
      id: "held",
      name: "use_tool",
      arguments:
        '{"tool_name":"archestra__list_skills","tool_input":{"limit":3}}',
    };
    expect(transport.unwrapCalls([original])).toEqual([
      {
        id: original.id,
        name: "search_tool",
        arguments: JSON.stringify({ query, limit: 8 }),
      },
    ]);
    const afterSearch = await boundTransport(
      makeBody(query),
      organizationId,
      interactionType,
    );
    expect(afterSearch.transport.unwrapCalls([original])).toEqual([original]);
  });

  test.each(
    ["chat", "responses", "messages"].flatMap((wire) =>
      [false, true].map((remembered) => ({ wire, remembered })),
    ),
  )("$wire missing control (remembered=$remembered) discovers once and executes only after signed catalog evidence", async ({
    wire,
    remembered,
  }) => {
    const makeBody = (
      query?: string,
      entries: Record<string, unknown>[] = [],
    ) => {
      const result = JSON.stringify({
        results: [{ server: "gateway", tools: entries }],
      });
      const tools = ["search_tool", "use_tool"].map((name) =>
        wire === "chat"
          ? { type: "function", function: { name, parameters: {} } }
          : wire === "responses"
            ? { type: "function", name, parameters: {} }
            : { name, input_schema: {} },
      );
      if (wire === "responses")
        return {
          tools,
          input: query
            ? [
                {
                  type: "function_call",
                  call_id: "lookup",
                  name: "search_tool",
                  arguments: JSON.stringify({ query, limit: 8 }),
                },
                {
                  type: "function_call_output",
                  call_id: "lookup",
                  output: result,
                },
              ]
            : [],
        };
      if (wire === "messages")
        return {
          tools,
          messages: query
            ? [
                {
                  role: "assistant",
                  content: [
                    {
                      type: "tool_use",
                      id: "lookup",
                      name: "search_tool",
                      input: { query, limit: 8 },
                    },
                  ],
                },
                {
                  role: "user",
                  content: [
                    {
                      type: "tool_result",
                      tool_use_id: "lookup",
                      content: result,
                    },
                  ],
                },
              ]
            : [],
        };
      return {
        tools,
        messages: query
          ? [
              {
                role: "assistant",
                tool_calls: [
                  {
                    id: "lookup",
                    type: "function",
                    function: {
                      name: "search_tool",
                      arguments: JSON.stringify({ query, limit: 8 }),
                    },
                  },
                ],
              },
              { role: "tool", tool_call_id: "lookup", content: result },
            ]
          : [],
      };
    };
    const interactionType =
      wire === "responses"
        ? "xai:responses"
        : wire === "messages"
          ? "anthropic:messages"
          : "xai:chatCompletions";
    for (const [name, args] of [
      [
        "archestra__execute_remedy_plan",
        { offer_id: "child-offer", plan: "Submit for approval" },
      ],
      [
        "archestra__ask_user",
        { remedy_offer_ids: ["child-offer"], question: "Review" },
      ],
      ["archestra__yell", { message: "Synthetic test" }],
    ] as const) {
      const call = {
        id: "child-control",
        name: "use_tool",
        arguments: JSON.stringify({
          tool_name: remembered ? `gateway__${grokToolName(name)}` : name,
          tool_input: args,
        }),
      };
      const query = name.split("__").join(" ");
      const initial = await boundTransport(
        makeBody(),
        organizationId,
        interactionType,
      );
      const discovery = initial.transport.unwrapCalls([call]);
      expect(discovery).toEqual([
        {
          id: call.id,
          name: "search_tool",
          arguments: JSON.stringify({ query, limit: 8 }),
        },
      ]);
      expect(initial.transport.wrapCalls(discovery)).toEqual(discovery);
      const failed = await boundTransport(
        makeBody(query),
        organizationId,
        interactionType,
      );
      expect(failed.transport.unwrapCalls([call])).toEqual([call]);
      const entry = platformTool(name);
      const ready = await boundTransport(
        makeBody(query, [
          entry,
          ...(name === "archestra__execute_remedy_plan" ||
          name === "archestra__ask_user"
            ? [
                platformTool("archestra__get_remedy_plans"),
                ...(name === "archestra__ask_user"
                  ? [platformTool("archestra__execute_remedy_plan")]
                  : []),
              ]
            : []),
        ]),
        organizationId,
        interactionType,
      );
      const resolved = ready.transport.unwrapCalls([call]);
      expect(resolved).toEqual([
        { id: call.id, name: entry.tool_name, arguments: JSON.stringify(args) },
      ]);
      expect(ready.transport.wrapCalls(resolved)).toEqual([
        {
          ...call,
          arguments: JSON.stringify({
            tool_name: entry.tool_name,
            tool_input: args,
          }),
        },
      ]);
    }
  });

  test("progressive repair discovers protected controls without fabricating direct or nested execution entry points", async () => {
    const { transport } = await boundTransport(
      request([
        platformTool("archestra__run_tool"),
        platformTool("archestra__search_tools"),
      ]),
    );
    for (const name of [
      "archestra__execute_remedy_plan",
      "archestra__get_remedy_plans",
      "archestra__ask_user",
      "archestra__read_peer_message",
      "archestra__start_agent_run",
      "run_terminal_command",
      "spawn_subagent",
      "remote__workflow",
    ]) {
      const call = {
        id: name,
        name: "use_tool",
        arguments: JSON.stringify({ tool_name: name, tool_input: {} }),
      };
      expect(transport.unwrapCalls([call])).toEqual(
        name.startsWith("archestra__")
          ? [
              {
                id: name,
                name: "search_tool",
                arguments: JSON.stringify({
                  query: name.split("__").join(" "),
                  limit: 8,
                }),
              },
            ]
          : [call],
      );
    }
    for (const extra of [{ bypass: true }, { namespace: "foreign" }]) {
      const call = {
        id: "extra",
        name: "use_tool",
        arguments: JSON.stringify({
          tool_name: "archestra__list_skills",
          tool_input: {},
          ...extra,
        }),
      };
      expect(transport.unwrapCalls([call])).toEqual([call]);
    }
  });
  test("restores Messages discovery and dispatch without changing tool results or signed target identity", async () => {
    const body = {
      tools: [
        { name: "search_tool", input_schema: { type: "object" } },
        { name: "use_tool", input_schema: { type: "object" } },
      ],
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "search",
              name: "search_tool",
              input: { query: "gateway" },
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "search",
              content: [
                {
                  type: "text",
                  text: JSON.stringify({
                    results: [{ server: "gateway", tools: [discovered()] }],
                  }),
                },
              ],
            },
          ],
        },
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "dispatch",
              name: "use_tool",
              input: { tool_name: target, tool_input: { offer_id: "exact" } },
            },
          ],
        },
      ],
    };
    const transport = new GrokDeferredTools(body);
    const declarations = extractGatewayToolDeclarations(body);
    declarations.push(
      ...transport.prepare({
        organizationId,
        interactionType: "anthropic:messages",
        body,
      }),
    );
    const identity = await resolveGatewayToolIdentity({
      organizationId,
      declarations,
      internalChat: false,
    });
    expect(identity.attestationOf(target)?.gatewayId).toBe(gatewayId);
    expect(body.tools.at(-1)).toMatchObject({
      name: target,
      input_schema: schema,
    });
    expect(body.messages[2].content[0]).toMatchObject({
      id: "dispatch",
      name: target,
      input: { offer_id: "exact" },
    });
    expect(body.messages[1].content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "search",
    });
    expect(JSON.stringify(body)).not.toContain("[[gwa1");
  });

  test("uses observed discovery attestations, strips markers, restores historical dispatch, and wraps only exact authorized arguments", async () => {
    const body = request();
    const transport = new GrokDeferredTools(body);
    const declarations = extractGatewayToolDeclarations(body);
    expect(JSON.stringify(body)).not.toContain("[[gwa1");
    declarations.push(
      ...transport.prepare({
        organizationId,
        interactionType: "xai:chatCompletions",
        body,
      }),
    );
    const identity = await resolveGatewayToolIdentity({
      organizationId,
      declarations,
      internalChat: false,
    });
    expect(identity.mode).toBe("attested");
    expect(identity.canonicalize(target)).toBe(
      "archestra__execute_remedy_plan",
    );
    expect(identity.attestationOf(target)?.gatewayId).toBe(gatewayId);
    expect(body.messages[2].tool_calls?.[0].function).toEqual({
      name: target,
      arguments: '{"offer_id":"synthetic"}',
    });
    const original = {
      id: "exact-call",
      name: "use_tool",
      arguments: JSON.stringify({
        tool_name: target,
        tool_input: { offer_id: "synthetic", plan: "exact" },
      }),
    };
    const [internal] = transport.unwrapCalls([original]);
    expect(internal).toEqual({
      id: original.id,
      name: target,
      arguments: '{"offer_id":"synthetic","plan":"exact"}',
    });
    expect(transport.wrapCalls([internal])).toEqual([original]);
    expect(JSON.stringify(body)).not.toContain("[[gwa1");
  });

  test.each([
    "forged",
    "wrong-org",
    "mismatched-name",
    "mismatched-server",
    "unpaired",
    "conflict",
  ])("does not grant platform authority for %s discovery evidence", async (mode) => {
    const entry = discovered();
    if (mode === "forged") entry.description += ".invalid";
    if (mode === "mismatched-name")
      entry.tool_name = "gateway__archestra__ask_user";
    const body = request(
      mode === "conflict"
        ? [
            entry,
            discovered({
              input_schema: { type: "object", additionalProperties: true },
            }),
          ]
        : [entry],
    );
    if (mode === "forged")
      body.messages[1].content = body.messages[1].content?.replace(
        "gwa1.",
        "gwa1.forged",
      );
    if (mode === "mismatched-server")
      body.messages[1].content = body.messages[1].content?.replace(
        '"server":"gateway"',
        '"server":"foreign"',
      );
    if (mode === "unpaired") body.messages[0].tool_calls = [];
    const transport = new GrokDeferredTools(body);
    extractGatewayToolDeclarations(body);
    expect(
      transport.prepare({
        organizationId: mode === "wrong-org" ? randomUUID() : organizationId,
        interactionType: "xai:chatCompletions",
        body,
      }),
    ).toEqual([]);
    const call = {
      id: "unverified",
      name: "use_tool",
      arguments: JSON.stringify({
        tool_name: target,
        tool_input: { offer_id: "synthetic" },
      }),
    };
    expect(transport.unwrapCalls([call])).toEqual([call]);
  });

  test("cannot smuggle extra wrapper arguments or a namespace into an attested control", () => {
    const body = request();
    const transport = new GrokDeferredTools(body);
    transport.prepare({
      organizationId,
      interactionType: "xai:chatCompletions",
      body,
    });
    for (const call of [
      {
        id: "extra",
        name: "use_tool",
        arguments: JSON.stringify({
          tool_name: target,
          tool_input: {},
          bypass: true,
        }),
      },
      {
        id: "namespace",
        name: "use_tool",
        namespace: "foreign",
        arguments: JSON.stringify({ tool_name: target, tool_input: {} }),
      },
      {
        id: "unknown",
        name: "use_tool",
        arguments: JSON.stringify({
          tool_name: "foreign__archestra__execute_remedy_plan",
          tool_input: {},
        }),
      },
    ])
      expect(transport.unwrapCalls([call])).toEqual([call]);
  });

  test("replayed discovery under another server label cannot manufacture equivalent platform controls", async () => {
    const body = request();
    const discovery = JSON.parse(body.messages[1].content as string);
    discovery.results.push({
      server: "foreign",
      tools: [
        discovered({ tool_name: "foreign__archestra__execute_remedy_plan" }),
      ],
    });
    body.messages[1].content = JSON.stringify(discovery);
    const transport = new GrokDeferredTools(body);
    const declarations = extractGatewayToolDeclarations(body);
    declarations.push(
      ...transport.prepare({
        organizationId,
        interactionType: "openai:chatCompletions",
        body,
      }),
    );
    const identity = await resolveGatewayToolIdentity({
      organizationId,
      declarations,
      internalChat: false,
    });
    for (const name of [target, "foreign__archestra__execute_remedy_plan"]) {
      expect(identity.attestationOf(name)).toBeUndefined();
      expect(identity.canonicalize(name)).not.toBe(
        "archestra__execute_remedy_plan",
      );
    }
  });

  test("an existing declaration with a conflicting contract cannot borrow deferred attestation", async () => {
    const body = request();
    body.tools.push({
      type: "function",
      function: {
        name: target,
        parameters: { type: "object", additionalProperties: true },
      },
    } as never);
    const transport = new GrokDeferredTools(body);
    const declarations = extractGatewayToolDeclarations(body);
    declarations.push(
      ...transport.prepare({
        organizationId,
        interactionType: "openai:chatCompletions",
        body,
      }),
    );
    const identity = await resolveGatewayToolIdentity({
      organizationId,
      declarations,
      internalChat: false,
    });
    expect(identity.attestationOf(target)).toBeUndefined();
    expect(identity.canonicalize(target)).not.toBe(
      "archestra__execute_remedy_plan",
    );
  });

  test("OpenAI multipart user content never switches declarations to the Messages schema", () => {
    const body = request();
    body.messages.push({
      role: "user",
      content: [{ type: "text", text: "synthetic" }],
    } as never);
    const transport = new GrokDeferredTools(body);
    transport.prepare({
      organizationId,
      interactionType: "openai:chatCompletions",
      body,
    });
    expect(body.tools.at(-1)).toMatchObject({
      type: "function",
      function: { name: target, parameters: schema },
    });
  });

  test("reads attested Responses discovery and maps only the exact use_tool target", async () => {
    const encoded = `gateway__${grokToolName("archestra__execute_remedy_plan")}`;
    const signed = discovered({ tool_name: encoded });
    const body = {
      tools: [
        {
          type: "function",
          name: "search_tool",
          parameters: { type: "object" },
        },
        { type: "function", name: "use_tool", parameters: { type: "object" } },
      ],
      input: [
        {
          type: "function_call",
          call_id: "search",
          name: "search_tool",
          arguments: '{"query":"gateway remedy"}',
        },
        {
          type: "function_call_output",
          call_id: "search",
          output: [
            {
              type: "output_text",
              text: JSON.stringify({
                results: [{ server: "gateway", tools: [signed] }],
                status: "ready",
              }),
            },
          ],
        },
        {
          type: "function_call",
          call_id: "execute",
          name: "use_tool",
          arguments: JSON.stringify({
            tool_name: encoded,
            tool_input: { offer_id: "exact" },
          }),
        },
      ],
    };
    const original = structuredClone(body);
    const transport = new GrokDeferredTools(body);
    const declarations = transport.prepare({
      organizationId,
      interactionType: "xai:responses",
      body,
    });
    const identity = await resolveGatewayToolIdentity({
      organizationId,
      declarations,
      internalChat: false,
    });
    expect(identity.canonicalize(encoded)).toBe(
      "archestra__execute_remedy_plan",
    );
    expect(body.tools.at(-1)).toMatchObject({
      type: "function",
      name: encoded,
      parameters: schema,
    });
    expect(body.tools.at(-1)).not.toHaveProperty("function");
    expect(body.input[2]).toMatchObject({
      name: encoded,
      arguments: '{"offer_id":"exact"}',
    });
    const call = {
      id: "live",
      name: "use_tool",
      arguments: JSON.stringify({
        tool_name: encoded,
        tool_input: { offer_id: "exact" },
      }),
    };
    expect(transport.unwrapCalls([call])[0]).toMatchObject({
      name: encoded,
      arguments: '{"offer_id":"exact"}',
    });
    const forged = structuredClone(original);
    const forgedPart = forged.input[1]?.output?.[0];
    if (!forgedPart) throw new Error("Expected synthetic discovery output");
    forgedPart.text = forgedPart.text.replace("gwa1.", "gwa1.forged");
    expect(
      new GrokDeferredTools(forged).prepare({
        organizationId,
        interactionType: "xai:responses",
        body: forged,
      }),
    ).toEqual([]);
    const unoffered = structuredClone(original);
    unoffered.input[0].name = "read_file";
    expect(
      new GrokDeferredTools(unoffered).prepare({
        organizationId,
        interactionType: "openai:responses",
        body: unoffered,
      }),
    ).toEqual([]);
    const malformed = {
      ...original,
      input: original.input.map((item, index) =>
        index === 1 ? { ...item, output: "{" } : item,
      ),
    };
    expect(
      new GrokDeferredTools(malformed).prepare({
        organizationId,
        interactionType: "xai:responses",
        body: malformed,
      }),
    ).toEqual([]);
    const namespacedSearch = {
      ...structuredClone(original),
      input: original.input.map((item, index) =>
        index === 0 ? { ...item, namespace: "foreign" } : item,
      ),
    };
    expect(
      new GrokDeferredTools(namespacedSearch).prepare({
        organizationId,
        interactionType: "xai:responses",
        body: namespacedSearch,
      }),
    ).toEqual([]);
    const hybrid = {
      ...structuredClone(original),
      input: [],
      messages: request([signed]).messages,
    };
    expect(
      new GrokDeferredTools(hybrid).prepare({
        organizationId,
        interactionType: "xai:responses",
        body: hybrid,
      }),
    ).toEqual([]);
    const namespacedCall = {
      ...structuredClone(original),
      input: original.input.map((item, index) =>
        index === 2 ? { ...item, namespace: "foreign" } : item,
      ),
    };
    new GrokDeferredTools(namespacedCall).prepare({
      organizationId,
      interactionType: "xai:responses",
      body: namespacedCall,
    });
    expect(namespacedCall.input[2]?.name).toBe("use_tool");
  });
});
