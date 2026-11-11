import type { LogRecord } from "@opentelemetry/api-logs";
import { vi } from "vitest";
import config from "@/config";
import logger from "@/logging";
import { createLogger } from "@/logging/create-logger";
import { createLogObserverStream } from "@/logging/observer-stream";
import AgentModel from "@/models/agent";
import { beforeEach, describe, expect, test } from "@/test";
import { type ArchestraContext, executeArchestraTool } from ".";

describe("built-in tool argument logging", () => {
  let context: ArchestraContext;
  let stdout: string[];
  let otel: LogRecord[];

  beforeEach(async ({ makeOrganization, makeUser, makeMember, makeAgent }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    const agent = await makeAgent({ organizationId: org.id });
    context = {
      agent: { id: agent.id, name: agent.name },
      userId: user.id,
      organizationId: org.id,
    };
    config.logs.contentMode = "metadata_only";
    config.observability.otel.captureContent = false;
    stdout = [];
    otel = [];
    // Keep the production serializer and both output branches. Only their
    // destinations are local, so leaked content cannot reach a real exporter.
    const capture = createLogger({
      level: "info",
      streams: [
        { level: "info", stream: { write: (chunk) => stdout.push(chunk) } },
        {
          level: "info",
          stream: createLogObserverStream({
            logger: { emit: (record) => otel.push(record) },
            retain: () => {},
          }),
        },
      ],
    });
    vi.spyOn(logger, "info").mockImplementation(capture.info.bind(capture));
  });

  function expectSafeLogs(
    tool: string,
    args: Record<string, unknown>,
    marker: string,
  ) {
    const records = stdout.map((line) => JSON.parse(line));
    const metadata = {
      agentId: context.agent.id,
      argumentKeys: expect.arrayContaining(Object.keys(args)),
      argumentsSize: expect.any(Number),
    };
    expect(
      records.find((record) => record.msg === `${tool} tool called`),
    ).toMatchObject(metadata);
    expect(
      otel.find((record) => record.body === `${tool} tool called`)?.attributes,
    ).toMatchObject(metadata);
    expect(stdout.join("\n")).not.toContain(marker);
    expect(JSON.stringify(otel)).not.toContain(marker);
  }

  test("todo_write keeps todo content out of stdout and OTEL", async () => {
    const marker = "PRIVATE-TODO-CONTENT";
    const args = { todos: [{ id: 1, content: marker, status: "pending" }] };
    const result = await executeArchestraTool(
      "archestra__todo_write",
      args,
      context,
    );
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({ success: true, todoCount: 1 });
    expectSafeLogs("todo_write", args, marker);
  });

  test.for([
    "agent",
    "mcp_gateway",
  ] as const)("create and edit %s keep arguments private without changing persistence", async (type) => {
    const marker = `PRIVATE-${type}-CONTENT`;
    const args = {
      name: "Logging privacy regression",
      labels: [{ key: "privacy", value: marker }],
      ...(type === "agent"
        ? {
            description: `${marker} description`,
            systemPrompt: `${marker} instructions`,
            suggestedPrompts: [
              { summaryTitle: `${marker} title`, prompt: `${marker} prompt` },
            ],
          }
        : {}),
    };
    const result = await executeArchestraTool(
      `archestra__create_${type}`,
      args,
      context,
    );
    expect(result.isError, JSON.stringify(result.content)).toBe(false);
    const text = result.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("\n");
    const id = /ID: ([0-9a-f-]+)/.exec(text)?.[1];
    expect(id).toBeDefined();
    const created = await AgentModel.findById(
      id as string,
      context.userId,
      true,
    );
    expect(created).toMatchObject(args);
    expectSafeLogs(`create_${type}`, args, marker);

    stdout.length = 0;
    otel.length = 0;
    const editArgs = {
      ...args,
      id,
      labels: [{ key: "privacy", value: `${marker} edited` }],
    };
    const edited = await executeArchestraTool(
      `archestra__edit_${type}`,
      editArgs,
      context,
    );
    expect(edited.isError, JSON.stringify(edited.content)).toBe(false);
    expect(
      await AgentModel.findById(id as string, context.userId, true),
    ).toMatchObject(editArgs);
    expectSafeLogs(`edit_${type}`, editArgs, marker);
  });
});
