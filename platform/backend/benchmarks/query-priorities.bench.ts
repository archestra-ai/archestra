/**
 * Manual, synthetic PGlite benchmark. Run from platform/:
 * ARCHESTRA_DATABASE_URL=postgresql://test:test@localhost:5432/test pnpm --dir backend benchmark:queries
 *
 * Compare the same file on the base and patched revisions, on an otherwise idle
 * machine. Reports seven samples after warmup, with the delta reconstruction
 * cache cleared before each sample. Catalog cases cover both newly seeded and
 * ANALYZE'd statistics. These are local model timings, not deployed latency.
 */
import { sql } from "drizzle-orm";
import db, { schema } from "@/database";
import AgentModel from "@/models/agent";
import InteractionModel from "@/models/interaction";
import InteractionDeltaManager from "@/models/interaction-delta-manager";
import { expect, test } from "@/test";
import { drainBackgroundWork } from "@/utils/background-work";

test("query priorities synthetic benchmark", async ({
  makeUser,
  makeOrganization,
  makeMember,
  makeAgent,
}) => {
  const org = await makeOrganization();
  const user = await makeUser();
  await makeMember(user.id, org.id, { role: "admin" });
  await db
    .insert(schema.agentsTable)
    .values(
      Array.from({ length: 3000 }, (_, n) => ({
        organizationId: org.id,
        authorId: n % 2 ? user.id : null,
        name: `Synthetic agent ${String(n).padStart(5, "0")}`,
        agentType: "agent" as const,
        description: "Synthetic description ".repeat(100),
      })),
    )
    .returning();
  const agents = await db
    .select({ id: schema.agentsTable.id })
    .from(schema.agentsTable);
  for (let offset = 0; offset < agents.length; offset += 500) {
    await db.insert(schema.resourcePermissionPoliciesTable).values(
      agents.slice(offset, offset + 500).map((a) => ({
        organizationId: org.id,
        resource: "agent" as const,
        scope: a.id,
        grants: [
          {
            subject: { type: "organization" as const, id: "*" as const },
            actions: ["read" as const, "use" as const],
          },
        ],
      })),
    );
  }
  const sessionAgent = await makeAgent({ organizationId: org.id });
  for (let session = 0; session < 10; session++) {
    const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
    for (let turn = 0; turn < 20; turn++) {
      messages.push({
        role: "user",
        content: `Session ${session} turn ${turn} ${"history ".repeat(1000)}`,
      });
      await InteractionModel.create({
        profileId: sessionAgent.id,
        sessionId: `synthetic-session-${session}`,
        sessionSource: "claude_metadata",
        type: "anthropic:messages",
        request: {
          model: "claude-test",
          max_tokens: 100,
          messages: [...messages],
        },
        response: {
          id: "synthetic",
          type: "message",
          role: "assistant",
          model: "claude-test",
          content: [{ type: "text", text: "answer" }],
          stop_reason: "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        },
      });
      messages.push({ role: "assistant", content: "answer" });
    }
  }
  await drainBackgroundWork();
  const runs: Record<string, number[]> = {};
  const measure = async (name: string, fn: () => Promise<unknown>) => {
    await fn();
    runs[name] = [];
    for (let n = 0; n < 7; n++) {
      InteractionDeltaManager.reset();
      const start = performance.now();
      await fn();
      runs[name].push(performance.now() - start);
    }
  };
  await measure("sessions", async () => {
    const result = await InteractionModel.getSessions(
      { limit: 10, offset: 0 },
      user.id,
      true,
      { organizationId: org.id, profileId: sessionAgent.id },
    );
    expect(result.data).toHaveLength(10);
    expect(
      result.data.every((s) => s.lastUserMessagePreview?.includes("turn 19")),
    ).toBe(true);
  });
  await measure("catalog", async () => {
    const result = await AgentModel.findCatalogCandidates({
      pagination: { limit: 10, offset: 0 },
      userId: user.id,
      isAgentAdmin: true,
      filters: {
        organizationId: org.id,
        access: { relations: ["mine", "shared", "org"] },
      },
    });
    expect(result.rows).toHaveLength(10);
  });
  await measure("delegation", async () => {
    const result = await AgentModel.findAccessibleDelegationTargets({
      organizationId: org.id,
      userId: user.id,
      isAdmin: true,
      excludeAgentId: sessionAgent.id,
      environmentId: null,
    });
    expect(result.length).toBeGreaterThanOrEqual(3000);
  });
  await db.execute(sql`ANALYZE agents`);
  await db.execute(sql`ANALYZE resource_permission_policies`);
  await measure("catalog-analyzed", async () => {
    const result = await AgentModel.findCatalogCandidates({
      pagination: { limit: 10, offset: 0 },
      userId: user.id,
      isAgentAdmin: true,
      filters: {
        organizationId: org.id,
        access: { relations: ["mine", "shared", "org"] },
      },
    });
    expect(result.rows).toHaveLength(10);
  });
  await measure("delegation-dispatch", async () => {
    const result = await AgentModel.findAccessibleDelegationTargets({
      organizationId: org.id,
      userId: user.id,
      isAdmin: true,
      excludeAgentId: sessionAgent.id,
      environmentId: null,
      includeDetails: false,
    });
    expect(result.length).toBeGreaterThanOrEqual(3000);
  });
  const targets = await AgentModel.findAccessibleDelegationTargets({
    organizationId: org.id,
    userId: user.id,
    isAdmin: true,
    excludeAgentId: sessionAgent.id,
    environmentId: null,
    includeDetails: false,
  });
  process.stdout.write(
    `SYNTHETIC_BENCHMARK ${JSON.stringify({ milliseconds: runs, dispatchResultBytes: Buffer.byteLength(JSON.stringify(targets)) })}\n`,
  );
}, 120000);
