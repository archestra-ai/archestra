import {
  PROXY_STAMPED_TOOL_ARGUMENTS,
  TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME,
  TOOL_GET_REMEDY_PLANS_SHORT_NAME,
} from "@archestra/shared";
import { describe, expect, test } from "vitest";
import { tools as openappaMcpTools } from "@/archestra-mcp-server/openappa";
import { prepareAppaRequest } from "./request";

const CONTROL = `archestra__${TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME}`;
const NOTICE = `archestra__${TOOL_GET_REMEDY_PLANS_SHORT_NAME}`;

const identity = {
  mode: "compat" as const,
  gatewayConnected: true,
  canonicalize: (name: string, namespace?: string) => {
    const joined = namespace ? `${namespace}__${name}` : name;
    const at = joined.lastIndexOf("archestra__");
    return at >= 0 ? joined.slice(at) : joined;
  },
  attestationOf: () => undefined,
  verified: [],
  unverifiedMarkerCount: 0,
};

function canonicalControl() {
  const tool = openappaMcpTools.find((entry) =>
    entry.name.endsWith(TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME),
  );
  if (!tool?.description || !tool.inputSchema) {
    throw new Error("missing execute_remedy_plan definition");
  }
  const schema = structuredClone(tool.inputSchema) as Record<string, unknown>;
  const stamped = new Set<string>(
    PROXY_STAMPED_TOOL_ARGUMENTS[TOOL_EXECUTE_REMEDY_PLAN_SHORT_NAME],
  );
  const properties = schema.properties;
  if (
    properties &&
    typeof properties === "object" &&
    !Array.isArray(properties)
  ) {
    schema.properties = Object.fromEntries(
      Object.entries(properties).filter(([name]) => !stamped.has(name)),
    );
  }
  if (Array.isArray(schema.required)) {
    schema.required = schema.required.filter(
      (name) => typeof name !== "string" || !stamped.has(name),
    );
  }
  return { description: tool.description, schema };
}

describe("canonical execute_remedy_plan declaration", () => {
  const expected = canonicalControl();

  test("uses one Anthropic schema whether the caller declared the control tool", () => {
    const read = {
      name: "read_file",
      description: "Read",
      input_schema: {
        type: "object",
        properties: { path: { type: "string" } },
      },
      cache_control: { type: "ephemeral" },
    };
    const missing = {
      tools: [
        read,
        {
          name: NOTICE,
          input_schema: { type: "object", properties: {} },
        },
      ],
      messages: [{ role: "user", content: "hello" }],
    };
    prepareAppaRequest({
      body: missing,
      interactionType: "anthropic:messages",
      identity,
    });
    const injected = missing.tools.at(-1);
    expect(missing.tools.map((tool) => tool.name)).toEqual([
      "read_file",
      CONTROL,
    ]);
    expect(missing.tools[0]).toBe(read);
    expect(read.input_schema).toEqual({
      type: "object",
      properties: { path: { type: "string" } },
    });
    expect(injected).toMatchObject({
      name: CONTROL,
      description: expected.description,
      input_schema: expected.schema,
    });

    const cache = { type: "ephemeral", ttl: "1h" };
    const declared = {
      name: CONTROL,
      description: "client copy",
      input_schema: {
        type: "object",
        properties: {
          offer_id: { type: "string" },
          execution: { type: "object" },
        },
        required: ["offer_id", "execution"],
      },
      cache_control: cache,
    };
    const write = {
      name: "write_file",
      description: "Write",
      input_schema: {
        type: "object",
        properties: { path: { type: "string" } },
      },
    };
    const present = {
      tools: [
        {
          name: "read_file",
          description: "Read",
          input_schema: {
            type: "object",
            properties: { path: { type: "string" } },
          },
        },
        declared,
        { name: NOTICE, input_schema: { type: "object", properties: {} } },
        write,
      ],
      messages: [{ role: "user", content: "hello" }],
    };
    prepareAppaRequest({
      body: present,
      interactionType: "anthropic:messages",
      identity,
    });
    prepareAppaRequest({
      body: present,
      interactionType: "anthropic:messages",
      identity,
    });

    expect(present.tools.map((tool) => tool.name)).toEqual([
      "read_file",
      CONTROL,
      "write_file",
    ]);
    expect(present.tools[1]).toBe(declared);
    expect(declared.description).toBe(expected.description);
    expect(declared.input_schema).toEqual(expected.schema);
    expect(declared.input_schema).toEqual(injected?.input_schema);
    expect(declared.cache_control).toBe(cache);
    expect(present.tools[2]).toBe(write);
    expect(write.input_schema).toEqual({
      type: "object",
      properties: { path: { type: "string" } },
    });
    expect(expected.schema.properties).toHaveProperty("offer_id");
    expect(expected.schema.properties).not.toHaveProperty("execution");
    expect(expected.schema.properties).not.toHaveProperty("signature");
  });

  test("uses the same Responses parameters for a missing and a declared control tool", () => {
    const missing = {
      tools: [
        {
          type: "function",
          name: "read_file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
          },
        },
        {
          type: "function",
          name: NOTICE,
          parameters: { type: "object", properties: {} },
        },
      ],
      input: [],
    };
    prepareAppaRequest({
      body: missing,
      interactionType: "openai:responses",
      identity,
    });
    const injected = missing.tools.at(-1);

    const cache = { type: "ephemeral" };
    const declared = {
      type: "function",
      name: CONTROL,
      description: "client copy",
      parameters: { type: "object", properties: {} },
      cache_control: cache,
    };
    const present = {
      tools: [
        {
          type: "function",
          name: "read_file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
          },
        },
        declared,
        {
          type: "function",
          name: NOTICE,
          parameters: { type: "object", properties: {} },
        },
      ],
      input: [],
    };
    prepareAppaRequest({
      body: present,
      interactionType: "openai:responses",
      identity,
    });

    expect(injected).toMatchObject({
      name: CONTROL,
      description: expected.description,
      parameters: expected.schema,
    });
    expect(declared.parameters).toEqual(expected.schema);
    expect(declared.parameters).toEqual(injected?.parameters);
    expect(declared.cache_control).toBe(cache);
    expect(present.tools.map((tool) => tool.name)).toEqual([
      "read_file",
      CONTROL,
    ]);
  });

  test("uses the same Chat function schema and keeps the caller's tool order", () => {
    const read = {
      type: "function",
      function: {
        name: "read_file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
        },
      },
    };
    const missing = {
      tools: [
        read,
        {
          type: "function",
          function: {
            name: NOTICE,
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      messages: [{ role: "user", content: "hello" }],
    };
    prepareAppaRequest({
      body: missing,
      interactionType: "openai:chatCompletions",
      identity,
    });
    const injected = missing.tools.at(-1)?.function;

    const cache = { type: "ephemeral" };
    const declaredFunction = {
      name: CONTROL,
      description: "client copy",
      parameters: {
        type: "object",
        properties: { payload: { type: "string" } },
      },
      cache_control: cache,
    };
    const declared = { type: "function", function: declaredFunction };
    const write = {
      type: "function",
      function: {
        name: "write_file",
        parameters: {
          type: "object",
          properties: { path: { type: "string" } },
        },
      },
    };
    const present = {
      tools: [
        {
          type: "function",
          function: {
            name: "read_file",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
            },
          },
        },
        declared,
        {
          type: "function",
          function: {
            name: NOTICE,
            parameters: { type: "object", properties: {} },
          },
        },
        write,
      ],
      messages: [{ role: "user", content: "hello" }],
    };
    prepareAppaRequest({
      body: present,
      interactionType: "openai:chatCompletions",
      identity,
    });

    expect(injected).toMatchObject({
      name: CONTROL,
      description: expected.description,
      parameters: expected.schema,
    });
    expect(declaredFunction.parameters).toEqual(expected.schema);
    expect(declaredFunction.description).toBe(expected.description);
    expect(declaredFunction.cache_control).toBe(cache);
    expect(present.tools.map((tool) => tool.function.name)).toEqual([
      "read_file",
      CONTROL,
      "write_file",
    ]);
    expect(present.tools[1]).toBe(declared);
    expect(present.tools[2]).toBe(write);
    expect(write.function.parameters).toEqual({
      type: "object",
      properties: { path: { type: "string" } },
    });
  });

  test("keeps a namespace member in place when normalizing its schema", () => {
    const cache = { type: "ephemeral" };
    const exec = {
      type: "function",
      name: "exec_command",
      parameters: { type: "object", properties: { cmd: { type: "string" } } },
    };
    const member = {
      type: "function",
      name: CONTROL,
      description: "client copy",
      parameters: {
        type: "object",
        properties: { execution: { type: "object" } },
      },
      cache_control: cache,
    };
    const namespace = {
      type: "namespace",
      name: "mcp__gw",
      tools: [
        exec,
        {
          type: "function",
          name: NOTICE,
          parameters: { type: "object", properties: {} },
        },
        member,
      ],
    };
    const body = { tools: [namespace], input: [] };
    prepareAppaRequest({
      body,
      interactionType: "openai:responses",
      identity,
    });

    expect(body.tools).toEqual([namespace]);
    expect(namespace.tools).toEqual([exec, member]);
    expect(member.parameters).toEqual(expected.schema);
    expect(member.description).toBe(expected.description);
    expect(member.cache_control).toBe(cache);
    expect(exec.parameters).toEqual({
      type: "object",
      properties: { cmd: { type: "string" } },
    });
  });

  test("uses Gemini parameters for a missing and a name-only control tool", () => {
    const read = {
      name: "read_file",
      description: "Read",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
      },
    };
    const missing = {
      tools: [
        {
          functionDeclarations: [
            read,
            { name: NOTICE, parameters: { type: "object", properties: {} } },
          ],
        },
      ],
      contents: [],
    };
    prepareAppaRequest({
      body: missing,
      interactionType: "gemini:generateContent",
      identity,
    });
    const injected = missing.tools[0].functionDeclarations.at(-1);

    const declared = { name: CONTROL, description: "client copy" };
    const echoed = {
      name: CONTROL,
      description: "client copy",
      input_schema: {
        type: "object",
        properties: { execution: { type: "object" } },
      },
    };
    const present = {
      tools: [
        {
          functionDeclarations: [
            read,
            declared,
            { name: NOTICE },
            {
              name: "write_file",
              parameters: {
                type: "object",
                properties: { path: { type: "string" } },
              },
            },
          ],
        },
      ],
      contents: [],
    };
    prepareAppaRequest({
      body: present,
      interactionType: "gemini:generateContent",
      identity,
    });
    const echoedBody = {
      tools: [{ functionDeclarations: [echoed, { name: NOTICE }] }],
      contents: [],
    };
    prepareAppaRequest({
      body: echoedBody,
      interactionType: "gemini:generateContent",
      identity,
    });

    expect(injected).toEqual({
      name: CONTROL,
      description: expected.description,
      parameters: expected.schema,
    });
    expect(injected).not.toHaveProperty("input_schema");
    expect(
      present.tools[0].functionDeclarations.map((tool) => tool.name),
    ).toEqual(["read_file", CONTROL, "write_file"]);
    expect(present.tools[0].functionDeclarations[0]).toBe(read);
    expect(present.tools[0].functionDeclarations[1]).toBe(declared);
    expect(declared).toEqual({
      name: CONTROL,
      description: expected.description,
      parameters: expected.schema,
    });
    expect(declared).not.toHaveProperty("input_schema");
    expect(echoed).toEqual({
      name: CONTROL,
      description: expected.description,
      parameters: expected.schema,
    });
    expect(JSON.stringify(echoedBody.tools)).not.toContain("input_schema");
  });

  test("keeps a declared Gemini parametersJsonSchema and does not add parameters", () => {
    const declared = {
      name: CONTROL,
      description: "client copy",
      parametersJsonSchema: {
        type: "object",
        properties: { offer_id: { type: "string" } },
      },
    };
    const body = {
      tools: {
        functionDeclarations: [declared, { name: NOTICE }],
      },
      contents: [],
    };
    prepareAppaRequest({
      body,
      interactionType: "gemini:generateContent",
      identity,
    });

    expect(body.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: CONTROL,
            description: expected.description,
            parametersJsonSchema: expected.schema,
          },
        ],
      },
    ]);
    expect(declared).not.toHaveProperty("parameters");
    expect(declared).not.toHaveProperty("input_schema");
  });

  test("uses Bedrock toolSpec json for a missing and a declared control tool", () => {
    const read = {
      toolSpec: {
        name: "read_file",
        description: "Read",
        inputSchema: {
          json: { type: "object", properties: { path: { type: "string" } } },
        },
      },
    };
    const missing = {
      toolConfig: {
        tools: [read, { toolSpec: { name: NOTICE } }],
      },
      messages: [],
    };
    prepareAppaRequest({
      body: missing,
      interactionType: "bedrock:converse",
      identity,
    });

    const declaredSpec = {
      name: CONTROL,
      description: "client copy",
      inputSchema: {
        json: { type: "object", properties: { execution: { type: "object" } } },
      },
    };
    const present = {
      toolConfig: {
        tools: [
          {
            toolSpec: {
              name: "read_file",
              inputSchema: { json: { type: "object" } },
            },
          },
          { toolSpec: declaredSpec },
          { toolSpec: { name: NOTICE } },
          {
            toolSpec: {
              name: "write_file",
              inputSchema: { json: { type: "object" } },
            },
          },
        ],
      },
      messages: [],
    };
    prepareAppaRequest({
      body: present,
      interactionType: "bedrock:converse",
      identity,
    });

    expect(missing.toolConfig.tools.map((tool) => tool.toolSpec.name)).toEqual([
      "read_file",
      CONTROL,
    ]);
    expect(missing.toolConfig.tools[0]).toBe(read);
    expect(missing.toolConfig.tools[1].toolSpec).toEqual({
      name: CONTROL,
      description: expected.description,
      inputSchema: { json: expected.schema },
    });
    expect(present.toolConfig.tools.map((tool) => tool.toolSpec.name)).toEqual([
      "read_file",
      CONTROL,
      "write_file",
    ]);
    expect(declaredSpec.description).toBe(expected.description);
    expect(declaredSpec.inputSchema.json).toEqual(expected.schema);
    expect(present.toolConfig.tools[2].toolSpec).toEqual({
      name: "write_file",
      inputSchema: { json: { type: "object" } },
    });
  });
});
