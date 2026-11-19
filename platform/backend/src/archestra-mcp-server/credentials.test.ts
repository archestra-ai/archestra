import {
  REDACTED_PLACEHOLDER,
  redactCatalogToolArguments,
  TOOL_TRANSFER_CREDENTIAL_FULL_NAME,
} from "@archestra/shared";
import { vi } from "vitest";
import { CacheKey, cacheManager } from "@/cache-manager";
import { AgentExcludedSubagentModel, AgentModel } from "@/models";
import { preflightAgentRuntimeCredentials } from "@/services/agent-runtime/credentials";
import { ephemeralCredentialGrantManager } from "@/services/agent-runtime/ephemeral-credential-grants";
import { resolveAgentRuntime } from "@/services/agent-runtime/pod-run";
import { beforeEach, expect, test } from "@/test";
import { setupTestCacheManager } from "@/test/cache-manager";
import type { Agent, AgentRuntime } from "@/types";
import { type ArchestraContext, executeArchestraTool } from ".";

setupTestCacheManager();

const SECRET_VALUE = "sk-transfer-PLAINTEXT-must-not-escape";

let organizationId: string;
let actorId: string;
let context: ArchestraContext;

function runtimeConfig(overrides: Partial<AgentRuntime> = {}): AgentRuntime {
  return {
    image: "ghcr.io/archestra/agent:latest",
    command: null,
    inferenceProtocol: "anthropic",
    backend: "kubernetes",
    steerMode: "pipe",
    privileged: false,
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
    const organization = await makeOrganization();
    organizationId = organization.id;
    const actor = await makeUser();
    actorId = actor.id;
    await makeMember(actorId, organizationId, { role: "admin" });
    const callingAgent = await makeAgent({
      organizationId,
      authorId: actorId,
      accessAllSubagents: true,
    });
    await seedAndAssignArchestraTools(callingAgent.id);
    context = {
      agent: { id: callingAgent.id, name: callingAgent.name },
      agentId: callingAgent.id,
      userId: actorId,
      organizationId,
    };
  },
);

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

/** Declare-only: the same call with no `value`. */
function declare(agentId: string, key = "MY_CLI_TOKEN") {
  return executeArchestraTool(
    TOOL_TRANSFER_CREDENTIAL_FULL_NAME,
    {
      agent_id: agentId,
      environment: [{ key, type: "secret" }],
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

test("declares a credential without a value and returns a paste link", async ({
  makeAgent,
}) => {
  const target = await makeRuntimeAgent(makeAgent, runtimeConfig());

  const result = await declare(target.id);

  expect(result.isError).toBeFalsy();
  expect(result.structuredContent).toMatchObject({
    key: "MY_CLI_TOKEN",
    declarationCreated: true,
    valueStored: false,
  });
  const url = (result.structuredContent as { url: string }).url;
  expect(url).toContain(`/agents/${target.id}?setup=credentials`);
  expect(url).toContain("keys=MY_CLI_TOKEN");
  // The section parameter would be rewritten away by agentDetailHref, taking
  // `setup` with it, so the link must not carry one.
  expect(url).not.toContain("section=");
  // The paste link is handed over in the reply, where it opens; a question
  // form would show it as dead text. Both renderings say so.
  expect(textOf(result)).toContain(
    `Put this link in your reply text, never inside a question form, so the person can paste it: ${url}`,
  );
  expect(result.structuredContent).toMatchObject({
    next_step: expect.stringContaining("never inside a question form"),
  });

  const stored = await AgentModel.findById(target.id);
  expect(stored?.runtime?.credentials).toEqual([
    // Optional on purpose: a required declaration blocks every user's runs.
    expect.objectContaining({
      key: "MY_CLI_TOKEN",
      scope: "per_user",
      required: false,
    }),
  ]);

  // Declared but empty, so a run still cannot read it.
  const preflight = await preflightAgentRuntimeCredentials({
    runtime: resolveAgentRuntime(stored!)!,
    organizationId,
    userId: actorId,
  });
  expect(preflight.configured).not.toContain("MY_CLI_TOKEN");
});

// Declaring carries no secret, so the gate that governs storing one must not
// block it. This is the path a caller falls back to when storing is refused.
test("declares a credential even when the administrator turned the setting off", async ({
  makeAgent,
}) => {
  const target = await makeRuntimeAgent(
    makeAgent,
    runtimeConfig({ allowAgentSuppliedCredentialValues: false }),
  );

  const result = await declare(target.id);

  expect(result.isError).toBeFalsy();
  expect(result.structuredContent).toMatchObject({ valueStored: false });
});

test("declaring an already declared key creates nothing and still links", async ({
  makeAgent,
}) => {
  const target = await makeRuntimeAgent(
    makeAgent,
    runtimeConfig({
      credentials: [
        {
          key: "MY_CLI_TOKEN",
          scope: "per_user",
          label: "Existing",
          required: false,
        },
      ],
    }),
  );

  const result = await declare(target.id);

  expect(result.isError).toBeFalsy();
  expect(result.structuredContent).toMatchObject({
    declarationCreated: false,
    valueStored: false,
  });
  const stored = await AgentModel.findById(target.id);
  expect(stored?.runtime?.credentials).toEqual([
    expect.objectContaining({ key: "MY_CLI_TOKEN", label: "Existing" }),
  ]);
});

test("refuses to declare a key held at organization scope", async ({
  makeAgent,
}) => {
  const target = await makeRuntimeAgent(
    makeAgent,
    runtimeConfig({
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

  const result = await declare(target.id);

  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain("declared as a shared credential");
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

test("refuses to transfer a credential to an excluded or non-allowlisted subagent", async ({
  makeAgent,
}) => {
  const target = await makeRuntimeAgent(makeAgent, runtimeConfig());
  await AgentExcludedSubagentModel.replaceForAgent(context.agent.id, [
    target.id,
  ]);

  const excludedResult = await declare(target.id);

  expect(excludedResult.isError).toBe(true);
  expect(textOf(excludedResult)).toContain(
    `Agent "${target.name}" is not an allowed subagent of "${context.agent.name}".`,
  );

  await AgentExcludedSubagentModel.replaceForAgent(context.agent.id, []);
  await AgentModel.update(context.agent.id, { accessAllSubagents: false });

  const nonAllowlistedResult = await declare(target.id);

  expect(nonAllowlistedResult.isError).toBe(true);
  expect(textOf(nonAllowlistedResult)).toContain(
    `Agent "${target.name}" is not an allowed subagent of "${context.agent.name}".`,
  );
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

test("mints a one-time ephemeral credential_grant_id without writing to the database", async ({
  makeAgent,
}) => {
  const targetA = await makeAgent({
    organizationId,
    authorId: actorId,
    agentType: "agent",
    runtime: runtimeConfig(),
  });
  const targetB = await makeAgent({
    organizationId,
    authorId: actorId,
    agentType: "agent",
    runtime: runtimeConfig(),
  });

  const result = await executeArchestraTool(
    TOOL_TRANSFER_CREDENTIAL_FULL_NAME,
    {
      ephemeral: true,
      ttl_seconds: 120,
      environment: [{ key: "GH_TOKEN", type: "secret", value: SECRET_VALUE }],
    },
    context,
  );

  expect(result.isError).toBeFalsy();
  const structured = result.structuredContent as {
    key: string;
    ephemeral?: boolean;
    credential_grant_id?: string;
    expires_in_seconds?: number;
    valueStored: boolean;
  };
  expect(structured.key).toBe("GH_TOKEN");
  expect(structured.ephemeral).toBe(true);
  expect(structured.valueStored).toBe(true);
  expect(structured.expires_in_seconds).toBe(120);
  expect(typeof structured.credential_grant_id).toBe("string");

  // Neither target agent's DB declaration nor user_credentials row was written.
  const storedA = await AgentModel.findById(targetA.id);
  const storedB = await AgentModel.findById(targetB.id);
  expect(storedA?.runtime?.credentials ?? []).toEqual([]);
  expect(storedB?.runtime?.credentials ?? []).toEqual([]);
  const runtimeA = storedA ? resolveAgentRuntime(storedA) : null;
  if (!runtimeA) throw new Error("Expected runtimeA");
  const preflightA = await preflightAgentRuntimeCredentials({
    runtime: runtimeA,
    organizationId,
    userId: actorId,
  });
  expect(preflightA.configured).not.toContain("GH_TOKEN");

  // Stored in the shared cache so a separate replica instance can resolve and consume it.
  const grantId = structured.credential_grant_id ?? "";
  expect(grantId).not.toBe("");
  const grantCacheKey =
    `${CacheKey.EphemeralCredentialGrant}-${grantId}` as const;
  const cached = await cacheManager.get(grantCacheKey);
  expect(cached).toMatchObject({
    id: grantId,
    organizationId,
    userId: actorId,
    callerAgentId: context.agent.id,
    key: "GH_TOKEN",
  });
  const consumed = await ephemeralCredentialGrantManager.consumeGrants({
    grantIds: [grantId],
    organizationId,
    userId: actorId,
    callerAgentId: context.agent.id,
    candidateAgentIds: [targetA.id],
  });
  expect(consumed.ok).toBe(true);
  if (!consumed.ok) throw new Error("Expected grant consumption to succeed");
  expect(consumed.envForAgent(targetA.id)).toEqual({
    GH_TOKEN: SECRET_VALUE,
  });
  await expect(cacheManager.get(grantCacheKey)).resolves.toBeUndefined();

  // Restoring writes only the remaining lifetime, and restoring after expiresAt writes nothing.
  const setSpy = vi.spyOn(cacheManager, "set");
  const originalExpiresAt = consumed.grants[0]?.expiresAt ?? 0;
  const nowSpy = vi
    .spyOn(Date, "now")
    .mockReturnValue(originalExpiresAt - 12_500);
  await consumed.restore();
  expect(setSpy).toHaveBeenCalledWith(
    grantCacheKey,
    expect.objectContaining({ id: grantId, expiresAt: originalExpiresAt }),
    12_500,
  );
  await expect(cacheManager.get(grantCacheKey)).resolves.toMatchObject({
    id: grantId,
    expiresAt: originalExpiresAt,
  });

  // Consume again and restore after original expiry has passed: nothing is restored.
  const reconsumed = await ephemeralCredentialGrantManager.consumeGrants({
    grantIds: [grantId],
    organizationId,
    userId: actorId,
    callerAgentId: context.agent.id,
    candidateAgentIds: [targetA.id],
  });
  expect(reconsumed.ok).toBe(true);
  if (!reconsumed.ok) throw new Error("Expected second consume to succeed");
  setSpy.mockClear();
  nowSpy.mockReturnValue(originalExpiresAt + 1_000);
  await reconsumed.restore();
  expect(setSpy).not.toHaveBeenCalled();
  await expect(cacheManager.get(grantCacheKey)).resolves.toBeUndefined();
  nowSpy.mockRestore();
  setSpy.mockRestore();
});

test("lists all target subagent names and setup URLs when agent_id is omitted", async ({
  makeAgent,
}) => {
  const targetA = await makeAgent({
    name: "Subagent Alpha",
    organizationId,
    authorId: actorId,
    agentType: "agent",
    runtime: runtimeConfig(),
  });
  const targetB = await makeAgent({
    name: "Subagent Beta",
    organizationId,
    authorId: actorId,
    agentType: "agent",
    runtime: runtimeConfig(),
  });

  const declared = await executeArchestraTool(
    TOOL_TRANSFER_CREDENTIAL_FULL_NAME,
    {
      environment: [{ key: "MULTI_KEY", type: "secret" }],
    },
    context,
  );
  expect(declared.isError).toBeFalsy();
  const urls = (declared.structuredContent as { urls?: string[] }).urls ?? [];
  expect(urls).toEqual(
    expect.arrayContaining([
      expect.stringContaining(`/agents/${targetA.id}?setup=credentials`),
      expect.stringContaining(`/agents/${targetB.id}?setup=credentials`),
    ]),
  );

  const stored = await executeArchestraTool(
    TOOL_TRANSFER_CREDENTIAL_FULL_NAME,
    {
      environment: [{ key: "MULTI_KEY", type: "secret", value: SECRET_VALUE }],
    },
    context,
  );
  expect(stored.isError).toBeFalsy();
  expect(textOf(stored)).toContain("Subagent Alpha");
  expect(textOf(stored)).toContain("Subagent Beta");
});
