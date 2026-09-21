import {
  REDACTED_PLACEHOLDER,
  redactCatalogToolArguments,
  TOOL_TRANSFER_CREDENTIAL_FULL_NAME,
} from "@archestra/shared";
import config from "@/config";
import { AgentModel } from "@/models";
import { preflightAgentRuntimeCredentials } from "@/services/agent-runtime/credentials";
import { resolveAgentRuntime } from "@/services/agent-runtime/pod-run";
import { afterEach, beforeEach, expect, test } from "@/test";
import type { Agent, AgentRuntime } from "@/types";
import { type ArchestraContext, executeArchestraTool } from ".";

const SECRET_VALUE = "sk-transfer-PLAINTEXT-must-not-escape";

let organizationId: string;
let actorId: string;
let context: ArchestraContext;
let originalRuntimeEnabled: boolean;

function runtimeConfig(overrides: Partial<AgentRuntime> = {}): AgentRuntime {
  return {
    image: "ghcr.io/archestra/agent:latest",
    command: null,
    inferenceProtocol: "anthropic",
    backend: "kubernetes",
    steerMode: "pipe",
    privileged: false,
    resources: null,
    environment: null,
    credentials: null,
    ttlHours: null,
    idleTimeoutMinutes: null,
    ...overrides,
  };
}

function textOf(result: { content: unknown[] }): string {
  return (result.content[0] as { text: string }).text;
}

beforeEach(
  async ({
    makeAgent,
    makeMember,
    makeOrganization,
    makeUser,
    seedAndAssignArchestraTools,
  }) => {
    originalRuntimeEnabled = config.agentRuntime.enabled;
    config.agentRuntime.enabled = true;
    const organization = await makeOrganization();
    organizationId = organization.id;
    const actor = await makeUser();
    actorId = actor.id;
    await makeMember(actorId, organizationId, { role: "admin" });
    const callingAgent = await makeAgent({ organizationId, authorId: actorId });
    await seedAndAssignArchestraTools(callingAgent.id);
    context = {
      agent: { id: callingAgent.id, name: callingAgent.name },
      agentId: callingAgent.id,
      userId: actorId,
      organizationId,
    };
  },
);

afterEach(() => {
  config.agentRuntime.enabled = originalRuntimeEnabled;
});

async function makeRuntimeAgent(
  makeAgent: (overrides: Record<string, unknown>) => Promise<Agent>,
  runtime: AgentRuntime,
): Promise<Agent> {
  return makeAgent({ organizationId, authorId: actorId, runtime });
}

function transfer(agentId: string, key = "MY_CLI_TOKEN") {
  return executeArchestraTool(
    TOOL_TRANSFER_CREDENTIAL_FULL_NAME,
    {
      agent_id: agentId,
      environment: [{ key, type: "secret", value: SECRET_VALUE }],
    },
    context,
  );
}

// An Agent stored before this field existed carries no value for it. Those
// rows are never re-parsed, so "omitted" is the state most Agents are in and
// it has to keep working.
test("accepts a value when the Agent leaves the setting unset", async ({
  makeAgent,
}) => {
  const target = await makeRuntimeAgent(makeAgent, runtimeConfig());

  const result = await transfer(target.id);

  expect(result.isError).toBeFalsy();
  const stored = await AgentModel.findById(target.id);
  expect(stored?.runtime?.credentials).toEqual([
    expect.objectContaining({ key: "MY_CLI_TOKEN", scope: "per_user" }),
  ]);
});

test("refuses an Agent whose administrator turned the setting off", async ({
  makeAgent,
}) => {
  const target = await makeRuntimeAgent(
    makeAgent,
    runtimeConfig({ allowAgentSuppliedCredentialValues: false }),
  );

  const result = await transfer(target.id);

  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain(
    "does not accept credential values from a connected client",
  );
  const stored = await AgentModel.findById(target.id);
  expect(stored?.runtime?.credentials ?? []).toEqual([]);
});

test("refuses a key declared at organization scope instead of widening it", async ({
  makeAgent,
}) => {
  const target = await makeRuntimeAgent(
    makeAgent,
    runtimeConfig({
      allowAgentSuppliedCredentialValues: true,
      credentials: [
        {
          key: "MY_CLI_TOKEN",
          scope: "shared",
          label: "Shared token",
          required: false,
        },
      ],
    }),
  );

  const result = await transfer(target.id);

  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain("declared as a shared credential");
  const runtime = resolveAgentRuntime((await AgentModel.findById(target.id))!);
  const preflight = await preflightAgentRuntimeCredentials({
    runtime: runtime!,
    organizationId,
    userId: actorId,
  });
  expect(preflight.configured).not.toContain("MY_CLI_TOKEN");
});

test("declares a new key personally and stores the value for the caller", async ({
  makeAgent,
}) => {
  const target = await makeRuntimeAgent(
    makeAgent,
    runtimeConfig({ allowAgentSuppliedCredentialValues: true }),
  );

  const result = await transfer(target.id);

  expect(result.isError).toBeFalsy();
  expect(result.structuredContent).toMatchObject({
    key: "MY_CLI_TOKEN",
    scope: "personal",
    declarationCreated: true,
  });

  const stored = await AgentModel.findById(target.id);
  expect(stored?.runtime?.credentials).toEqual([
    expect.objectContaining({ key: "MY_CLI_TOKEN", scope: "per_user" }),
  ]);

  const preflight = await preflightAgentRuntimeCredentials({
    runtime: resolveAgentRuntime(stored!)!,
    organizationId,
    userId: actorId,
  });
  expect(preflight.configured).toContain("MY_CLI_TOKEN");
});

test("keeps the stored value personal to the caller", async ({
  makeAgent,
  makeMember,
  makeUser,
}) => {
  const target = await makeRuntimeAgent(
    makeAgent,
    runtimeConfig({ allowAgentSuppliedCredentialValues: true }),
  );
  await transfer(target.id);

  const otherUser = await makeUser();
  await makeMember(otherUser.id, organizationId, { role: "member" });
  const preflight = await preflightAgentRuntimeCredentials({
    runtime: resolveAgentRuntime((await AgentModel.findById(target.id))!)!,
    organizationId,
    userId: otherUser.id,
  });

  // `preflight.missing` only lists required declarations, so the isolation
  // property to assert is that the other user has nothing configured.
  expect(preflight.configured).not.toContain("MY_CLI_TOKEN");
});

test("does not reveal Agents outside the caller's organization", async ({
  makeAgent,
  makeOrganization,
  makeUser,
}) => {
  const otherOrg = await makeOrganization();
  const otherAuthor = await makeUser();
  const target = await makeAgent({
    organizationId: otherOrg.id,
    authorId: otherAuthor.id,
    runtime: runtimeConfig({ allowAgentSuppliedCredentialValues: true }),
  });

  const result = await transfer(target.id);

  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain("Agent not found");
});

test("reports an Agent with no runtime rather than storing a value", async ({
  makeAgent,
}) => {
  const target = await makeAgent({ organizationId, authorId: actorId });

  const result = await transfer(target.id);

  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain("no Agent Runtime configured");
});

test("its argument shape is redacted before a tool call is logged", () => {
  const args = {
    agent_id: "agent-1",
    environment: [{ key: "MY_CLI_TOKEN", type: "secret", value: SECRET_VALUE }],
  };

  const redacted = redactCatalogToolArguments(args);

  expect(JSON.stringify(redacted)).not.toContain(SECRET_VALUE);
  expect(redacted.environment[0].value).toBe(REDACTED_PLACEHOLDER);
  // The envelope form a search_and_run_only agent sends must redact too.
  const enveloped = redactCatalogToolArguments({ tool_args: args });
  expect(JSON.stringify(enveloped)).not.toContain(SECRET_VALUE);
});
