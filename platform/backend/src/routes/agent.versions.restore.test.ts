import { and, eq } from "drizzle-orm";
import { vi } from "vitest";
import db, { schema } from "@/database";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import {
  AgentExcludedSubagentModel,
  AgentExcludedToolModel,
  AgentModel,
  AgentToolModel,
  AgentVersionModel,
  HookFileModel,
  ToolModel,
} from "@/models";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";

vi.mock("@/observability");

describe("POST /api/agents/:id/versions/:version/restore", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeOrganization, makeAdmin, makeMember }) => {
    const organization = await makeOrganization();
    organizationId = organization.id;
    user = await makeAdmin();
    await makeMember(user.id, organizationId, { role: "admin" });

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      (request as typeof request & { user: User }).user = user;
      (request as typeof request & { organizationId: string }).organizationId =
        organizationId;
    });
    registerAuditLogHook(app);

    const { default: agentRoutes } = await import("./agent");
    await app.register(agentRoutes);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await app.close();
  });

  function restore(
    agentId: string,
    version: number,
    body?: { baseVersion?: number },
  ) {
    return app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/versions/${version}/restore`,
      ...(body ? { payload: body } : {}),
    });
  }

  test("replays an old snapshot forward as a new head version", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({
      organizationId,
      description: "original",
      systemPrompt: "be helpful",
    });
    await AgentModel.update(agent.id, {
      description: "rewritten",
      systemPrompt: "be terse",
    });

    const response = await restore(agent.id, 1);
    expect(response.statusCode).toBe(200);

    const { agent: restored, skipped } = response.json();
    expect(skipped).toEqual([]);
    expect(restored.description).toBe("original");
    expect(restored.systemPrompt).toBe("be helpful");

    // History is appended to, never rewritten: v1 and v2 both survive and the
    // restore lands as a new head rather than resetting the counter.
    const versions = await AgentVersionModel.listForAgent({
      agentId: agent.id,
      organizationId,
      pagination: { limit: 50, offset: 0 },
    });
    expect(versions.data.map((v) => v.version)).toEqual([3, 2, 1]);
  });

  test("returns the post-restore latestVersion so the next restore can anchor on it", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ organizationId, description: "original" });
    await AgentModel.update(agent.id, { description: "rewritten" });

    const first = await restore(agent.id, 1, { baseVersion: 2 });
    expect(first.statusCode).toBe(200);

    // The replay defers its forks, so a response built from the deferred
    // update would carry a stale head and 409 the next anchored restore.
    const head = first.json().agent.latestVersion;
    const stored = await AgentModel.findById(agent.id, user.id, true);
    expect(head).toBe(stored?.latestVersion);

    const second = await restore(agent.id, 2, { baseVersion: head });
    expect(second.statusCode).toBe(200);
  });

  test("restores the agent's name", async ({ makeAgent }) => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const agent = await makeAgent({
      organizationId,
      name: `Original ${suffix}`,
    });
    await AgentModel.update(agent.id, { name: `Renamed ${suffix}` });

    const response = await restore(agent.id, 1);
    expect(response.statusCode).toBe(200);
    expect(response.json().agent.name).toBe(`Original ${suffix}`);
  });

  test("restores the tool assignment set in both directions", async ({
    makeAgent,
    makeTool,
  }) => {
    const kept = await makeTool();
    const addedLater = await makeTool();

    const agent = await makeAgent({ organizationId, accessAllTools: false });
    await AgentToolModel.create(agent.id, kept.id);
    const versionWithOneTool = (await AgentVersionModel.forkIfChanged(agent.id))
      ?.version;

    await AgentToolModel.create(agent.id, addedLater.id);

    const response = await restore(agent.id, versionWithOneTool as number);
    expect(response.statusCode).toBe(200);
    expect(response.json().skipped).toEqual([]);

    const toolIds = await AgentToolModel.findToolIdsByAgent(agent.id);
    // The tool the snapshot lacks is unassigned, not merely left in place.
    expect(toolIds).toEqual([kept.id]);
  });

  test("records a tool deleted since capture in skipped, without failing", async ({
    makeAgent,
    makeTool,
  }) => {
    const doomed = await makeTool({ name: "doomed_tool" });

    const agent = await makeAgent({ organizationId, accessAllTools: false });
    await AgentToolModel.create(agent.id, doomed.id);
    const withTool = (await AgentVersionModel.forkIfChanged(agent.id))?.version;

    await AgentToolModel.delete({ agentId: agent.id, toolId: doomed.id });
    await ToolModel.delete(doomed.id);

    const response = await restore(agent.id, withTool as number);
    expect(response.statusCode).toBe(200);
    expect(response.json().skipped).toEqual(['Tool "doomed_tool"']);
  });

  test("skips a tool whose MCP server is no longer installed", async ({
    makeAgent,
    makeTool,
    makeInternalMcpCatalog,
  }) => {
    // A local-catalog tool needs an installed MCP server to be assignable. The
    // replay re-runs that validation against the current state of the tool and
    // its catalog rather than trusting the snapshot, so a version captured
    // while the server was installed cannot re-grant the tool after it is gone.
    // (The check is agent-scoped, not caller-scoped — nothing about the
    // restoring user changes here.)
    const catalog = await makeInternalMcpCatalog();
    const tool = await makeTool({
      catalogId: catalog.id,
      name: "local_server_tool",
    });

    const agent = await makeAgent({ organizationId, accessAllTools: false });
    await AgentToolModel.create(agent.id, tool.id);
    const withTool = (await AgentVersionModel.forkIfChanged(agent.id))?.version;

    await AgentToolModel.delete({ agentId: agent.id, toolId: tool.id });

    const response = await restore(agent.id, withTool as number);
    expect(response.statusCode).toBe(200);
    expect(response.json().skipped).toEqual(['Tool "local_server_tool"']);
    expect(await AgentToolModel.findToolIdsByAgent(agent.id)).toEqual([]);
  });

  test("keeps a live assignment the replay cannot re-apply", async ({
    makeAgent,
    makeTool,
    makeInternalMcpCatalog,
  }) => {
    // The same unassignable tool as above, except the agent still HAS it: a
    // static assignment outlives the installation it pinned (`mcp_server_id` is
    // ON DELETE SET NULL), so a working tool can fail the assign validator
    // while sitting in both the live config and the snapshot. Unassigning it
    // would make a restore strip tool access the target version explicitly
    // carried — and would do it even when restoring the current version.
    const catalog = await makeInternalMcpCatalog();
    const tool = await makeTool({
      catalogId: catalog.id,
      name: "still_assigned_tool",
    });

    const agent = await makeAgent({ organizationId, accessAllTools: false });
    await AgentToolModel.create(agent.id, tool.id);
    const withTool = (await AgentVersionModel.forkIfChanged(agent.id))?.version;

    const response = await restore(agent.id, withTool as number);
    expect(response.statusCode).toBe(200);
    // Reported, because the credential binding is not the one the version
    // recorded — but reporting is not revoking.
    expect(response.json().skipped).toEqual(['Tool "still_assigned_tool"']);
    expect(await AgentToolModel.findToolIdsByAgent(agent.id)).toEqual([
      tool.id,
    ]);
  });

  test("keeps the live LLM pair when only the version's API key is gone", async ({
    makeAgent,
    makeLlmProviderApiKey,
    makeSecret,
  }) => {
    const secret = await makeSecret();
    const oldKey = await makeLlmProviderApiKey(organizationId, secret.id);
    const liveKey = await makeLlmProviderApiKey(organizationId, secret.id);
    const model = await db
      .insert(schema.modelsTable)
      .values({
        externalId: "gpt-test",
        modelId: "gpt-test",
        provider: "openai",
      })
      .returning();

    const agent = await makeAgent({
      organizationId,
      modelId: model[0].id,
      llmApiKeyId: oldKey.id,
    });
    await AgentModel.update(agent.id, {
      modelId: model[0].id,
      llmApiKeyId: liveKey.id,
    });

    await db
      .delete(schema.llmProviderApiKeysTable)
      .where(eq(schema.llmProviderApiKeysTable.id, oldKey.id));

    const response = await restore(agent.id, 1);
    expect(response.statusCode).toBe(200);

    // A model/key pair is written whole or not at all — a half pair would be
    // rejected everywhere else in the system.
    const { agent: restored, skipped } = response.json();
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toContain("API key");
    expect(restored.llmApiKeyId).toBe(liveKey.id);
    expect(restored.modelId).toBe(model[0].id);
  });

  test("replaces the whole hook set", async ({ makeAgent }) => {
    const agent = await makeAgent({ organizationId });
    await HookFileModel.create({
      agentId: agent.id,
      organizationId,
      event: "session_start",
      fileName: "original.py",
      content: "print('original')",
      requirements: [],
      enabled: true,
    });
    const withOriginalHook = (await AgentVersionModel.forkIfChanged(agent.id))
      ?.version;

    await HookFileModel.create({
      agentId: agent.id,
      organizationId,
      event: "pre_tool_use",
      fileName: "added-later.py",
      content: "print('later')",
      requirements: [],
      enabled: true,
    });

    const response = await restore(agent.id, withOriginalHook as number);
    expect(response.statusCode).toBe(200);

    const hooks = await HookFileModel.listByAgent(agent.id, organizationId);
    expect(hooks.map((h) => h.fileName)).toEqual(["original.py"]);
    expect(hooks[0].content).toBe("print('original')");
  });

  test("rejects a stale baseVersion with 409 agent_version_conflict", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ organizationId, description: "original" });
    await AgentModel.update(agent.id, { description: "second" });
    await AgentModel.update(agent.id, { description: "third" });

    // The client composed its restore against v2, but the head is now v3.
    const response = await restore(agent.id, 1, { baseVersion: 2 });
    expect(response.statusCode).toBe(409);
    expect(response.json().error.message).toContain("has moved to version 3");
    expect(response.json().error.internal_code).toBe("agent_version_conflict");

    // The rejected restore left the config untouched.
    const agentRow = await AgentModel.findById(agent.id, user.id, true);
    expect(agentRow?.description).toBe("third");
  });

  test("without baseVersion the restore is last-write-wins", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ organizationId, description: "original" });
    await AgentModel.update(agent.id, { description: "second" });
    await AgentModel.update(agent.id, { description: "third" });

    const response = await restore(agent.id, 1);
    expect(response.statusCode).toBe(200);
    expect(response.json().agent.description).toBe("original");
  });

  test("404s a version dropped by retention or never written", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ organizationId });

    const response = await restore(agent.id, 99);
    expect(response.statusCode).toBe(404);
    expect(response.json().error.message).toContain("no version 99");
  });

  test("404s an agent in another organization", async ({
    makeAgent,
    makeOrganization,
  }) => {
    const otherOrg = await makeOrganization();
    const foreign = await makeAgent({ organizationId: otherOrg.id });
    await AgentModel.update(foreign.id, { description: "changed" });

    const response = await restore(foreign.id, 1);
    expect(response.statusCode).toBe(404);
  });

  test("403s a built-in agent", async ({ makeAgent }) => {
    const agent = await makeAgent({
      organizationId,
      builtInAgentConfig: { name: "context-compaction-subagent" },
    });
    await AgentModel.update(agent.id, { systemPrompt: "changed" });

    const response = await restore(agent.id, 1);
    expect(response.statusCode).toBe(403);
    expect(response.json().error.message).toContain("Built-in agents");
  });

  test("writes an agent.updated audit record with a non-empty diff", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ organizationId, description: "original" });
    await AgentModel.update(agent.id, { description: "rewritten" });

    const response = await restore(agent.id, 1);
    expect(response.statusCode).toBe(200);

    const auditRows = await db
      .select({
        action: schema.auditLogsTable.action,
        resourceType: schema.auditLogsTable.resourceType,
        before: schema.auditLogsTable.before,
        after: schema.auditLogsTable.after,
      })
      .from(schema.auditLogsTable)
      .where(
        and(
          eq(schema.auditLogsTable.action, "agent.updated"),
          eq(schema.auditLogsTable.resourceId, agent.id),
        ),
      );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0].resourceType).toBe("agent");
    expect(auditRows[0].before).toMatchObject({ description: "rewritten" });
    expect(auditRows[0].after).toMatchObject({ description: "original" });
  });

  test("a hook-only restore still produces a non-empty audit diff", async ({
    makeAgent,
  }) => {
    const agent = await makeAgent({ organizationId });
    const withoutHooks = (await AgentVersionModel.forkIfChanged(agent.id))
      ?.version;

    await HookFileModel.create({
      agentId: agent.id,
      organizationId,
      event: "session_start",
      fileName: "hook.py",
      content: "print('hi')",
      requirements: [],
      enabled: true,
    });

    const response = await restore(agent.id, withoutHooks as number);
    expect(response.statusCode).toBe(200);

    const [auditRow] = await db
      .select({
        before: schema.auditLogsTable.before,
        after: schema.auditLogsTable.after,
      })
      .from(schema.auditLogsTable)
      .where(
        and(
          eq(schema.auditLogsTable.action, "agent.updated"),
          eq(schema.auditLogsTable.resourceId, agent.id),
        ),
      );
    // Hooks are captured as identity only, but they must still diff — the
    // whole point of this restore is invisible in the agents row.
    expect(auditRow.before).toMatchObject({
      hooks: ["session_start/hook.py"],
    });
    expect(auditRow.after).toMatchObject({ hooks: [] });
  });

  test("an exclusion-only restore still produces a non-empty audit diff", async ({
    makeAgent,
    makeTool,
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({ organizationId });
    const tool = await makeTool({ catalogId: catalog.id });
    const agent = await makeAgent({ organizationId });
    const withoutExclusions = (await AgentVersionModel.forkIfChanged(agent.id))
      ?.version;

    await AgentExcludedToolModel.replaceForAgent(agent.id, [tool.id]);

    const response = await restore(agent.id, withoutExclusions as number);
    expect(response.statusCode).toBe(200);

    const [auditRow] = await db
      .select({
        before: schema.auditLogsTable.before,
        after: schema.auditLogsTable.after,
      })
      .from(schema.auditLogsTable)
      .where(
        and(
          eq(schema.auditLogsTable.action, "agent.updated"),
          eq(schema.auditLogsTable.resourceId, agent.id),
        ),
      );
    // Like hooks, exclusions live outside the agents row, so without them in
    // the audit projection an exclusion-only restore would log an empty diff.
    expect(auditRow.before).toMatchObject({ excludedToolIds: [tool.id] });
    expect(auditRow.after).toMatchObject({ excludedToolIds: [] });
  });

  test("restores the excluded-tool set in both directions", async ({
    makeAgent,
    makeTool,
    makeInternalMcpCatalog,
  }) => {
    // Only catalog-backed tools participate in the Auto-tool surface, so this
    // is what a real exclusion looks like.
    const catalog = await makeInternalMcpCatalog({ organizationId });
    const kept = await makeTool({ catalogId: catalog.id });
    const excludedLater = await makeTool({ catalogId: catalog.id });

    const agent = await makeAgent({ organizationId });
    await AgentExcludedToolModel.replaceForAgent(agent.id, [kept.id]);
    const withOneExclusion = (await AgentVersionModel.forkIfChanged(agent.id))
      ?.version;

    await AgentExcludedToolModel.replaceForAgent(agent.id, [excludedLater.id]);

    const response = await restore(agent.id, withOneExclusion as number);
    expect(response.statusCode).toBe(200);

    // A full replace, not a merge: the snapshot's exclusion comes back and the
    // one it does not carry is dropped.
    expect(await AgentExcludedToolModel.findToolIdsByAgent(agent.id)).toEqual([
      kept.id,
    ]);
  });

  test("restores the excluded-subagent set in both directions", async ({
    makeAgent,
  }) => {
    const kept = await makeAgent({ organizationId });
    const excludedLater = await makeAgent({ organizationId });

    const agent = await makeAgent({ organizationId });
    await AgentExcludedSubagentModel.replaceForAgent(agent.id, [kept.id]);
    const withOneExclusion = (await AgentVersionModel.forkIfChanged(agent.id))
      ?.version;

    await AgentExcludedSubagentModel.replaceForAgent(agent.id, [
      excludedLater.id,
    ]);

    const response = await restore(agent.id, withOneExclusion as number);
    expect(response.statusCode).toBe(200);

    expect(
      await AgentExcludedSubagentModel.findTargetAgentIdsByAgent(agent.id),
    ).toEqual([kept.id]);
  });

  test("the All-tools pre-fill does not survive the snapshot's exclusion set", async ({
    makeAgent,
    seedAndAssignArchestraTools,
  }) => {
    // Seed the built-in tools against a DIFFERENT agent: the pre-fill only
    // considers built-ins the target agent does not already have assigned, so
    // assigning them here would leave it with nothing to pre-fill and the test
    // would pass vacuously.
    const toolHolder = await makeAgent({ organizationId });
    await seedAndAssignArchestraTools(toolHolder.id);

    const agent = await makeAgent({ organizationId, accessAllTools: true });
    // Creating in All-tools mode pre-fills the exclusion baseline; clear it so
    // the snapshot records a deliberately empty set.
    await AgentExcludedToolModel.replaceForAgent(agent.id, []);
    const allToolsNoExclusions = (
      await AgentVersionModel.forkIfChanged(agent.id)
    )?.version;

    await AgentModel.update(agent.id, { accessAllTools: false });

    const response = await restore(agent.id, allToolsNoExclusions as number);
    expect(response.statusCode).toBe(200);
    expect(response.json().agent.accessAllTools).toBe(true);

    // The restore flips accessAllTools off→on, which makes AgentModel.update
    // re-run the additive built-in pre-fill. The exclusion replay runs AFTER
    // that update precisely so the snapshot's set wins; reorder the two and
    // this agent silently comes back with every built-in excluded.
    expect(await AgentExcludedToolModel.findToolIdsByAgent(agent.id)).toEqual(
      [],
    );
  });

  test("drops an exclusion whose tool was deleted, without reporting it", async ({
    makeAgent,
    makeTool,
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog({ organizationId });
    const doomed = await makeTool({ catalogId: catalog.id });
    const agent = await makeAgent({ organizationId });
    await AgentExcludedToolModel.replaceForAgent(agent.id, [doomed.id]);
    const withExclusion = (await AgentVersionModel.forkIfChanged(agent.id))
      ?.version;

    // How a catalog-backed tool actually goes away: deleting its catalog
    // soft-deletes the tool rows, which every ToolModel read treats as gone.
    await ToolModel.softDeleteByCatalog(catalog.id, new Date());

    const response = await restore(agent.id, withExclusion as number);
    expect(response.statusCode).toBe(200);
    // An exclusion of a deleted tool is inert, so losing it changes nothing
    // about the restored behavior and must not add noise to `skipped`.
    expect(response.json().skipped).toEqual([]);
    expect(await AgentExcludedToolModel.findToolIdsByAgent(agent.id)).toEqual(
      [],
    );
  });

  test("reports a credential mode the current schema no longer knows", async ({
    makeAgent,
    makeTool,
  }) => {
    const tool = await makeTool({ name: "renamed_mode_tool" });
    const agent = await makeAgent({ organizationId, accessAllTools: false });
    await AgentToolModel.create(agent.id, tool.id);
    const withTool = (await AgentVersionModel.forkIfChanged(agent.id))?.version;

    // Move the head past the captured version before rewriting it: the
    // pre-restore fork compares the live config against the HEAD row's
    // contentHash, which a hand-edited head snapshot would invalidate.
    await AgentModel.update(agent.id, { description: "moved the head" });

    // Simulate a snapshot written before the credential-mode enum changed.
    // Snapshots keep the value as a plain string exactly so old history stays
    // readable, which means the replay has to cope with one it cannot parse.
    const [versionRow] = await db
      .select({ snapshot: schema.agentVersionsTable.snapshot })
      .from(schema.agentVersionsTable)
      .where(
        and(
          eq(schema.agentVersionsTable.agentId, agent.id),
          eq(schema.agentVersionsTable.version, withTool as number),
        ),
      );
    await db
      .update(schema.agentVersionsTable)
      .set({
        snapshot: {
          ...versionRow.snapshot,
          tools: versionRow.snapshot.tools.map((t) => ({
            ...t,
            credentialResolutionMode: "legacy_static",
          })),
        },
      })
      .where(
        and(
          eq(schema.agentVersionsTable.agentId, agent.id),
          eq(schema.agentVersionsTable.version, withTool as number),
        ),
      );

    const response = await restore(agent.id, withTool as number);
    expect(response.statusCode).toBe(200);

    // The tool still lands — dropping it would strip the agent's whole tool set
    // the day the enum is renamed — but under the `static` default rather than
    // the mode the version recorded, so the downgrade has to be visible.
    expect(await AgentToolModel.findToolIdsByAgent(agent.id)).toEqual([
      tool.id,
    ]);
    expect(response.json().skipped).toEqual([
      'Credential mode "legacy_static" for tool "renamed_mode_tool"',
    ]);
  });

  test("403s when a member restores another user's personal agent", async ({
    makeAgent,
    makeUser,
    makeMember,
  }) => {
    const agent = await makeAgent({
      organizationId,
      scope: "personal",
      authorId: user.id,
    });
    await AgentModel.update(agent.id, { description: "changed" });

    // A plain member holds agent:update, so the agent-type check passes; the
    // scope check is what must stop them touching someone else's personal
    // agent. Without it, version history would be a way around the ownership
    // rules the update route enforces.
    const outsider = await makeUser();
    await makeMember(outsider.id, organizationId);
    user = outsider;

    const response = await restore(agent.id, 1);
    expect(response.statusCode).toBe(403);

    const agentRow = await AgentModel.findById(agent.id, undefined, true);
    expect(agentRow?.description).toBe("changed");
  });
});
