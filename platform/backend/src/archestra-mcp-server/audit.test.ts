import {
  ARCHESTRA_MCP_SERVER_NAME,
  MCP_SERVER_TOOL_NAME_SEPARATOR,
} from "@archestra/shared";
import AuditLogModel from "@/models/audit-log";
import SkillModel from "@/models/skill";
import TeamModel from "@/models/team";
import { beforeEach, describe, expect, test } from "@/test";
import type { Agent } from "@/types";
import { type ArchestraContext, executeArchestraTool } from ".";

const toolName = (shortName: string) =>
  `${ARCHESTRA_MCP_SERVER_NAME}${MCP_SERVER_TOOL_NAME_SEPARATOR}${shortName}`;

const MANIFEST = [
  "---",
  "name: audit-probe",
  "description: A skill for audit tests.",
  "---",
  "",
  "# audit-probe",
  "Original instructions.",
].join("\n");

/**
 * Mutating Archestra MCP tools must write org-audit rows with the same event
 * vocabulary and snapshots as their /api/* twins — the MCP surface bypasses
 * the HTTP audit hook entirely, so the dispatch-level writer is the only
 * trail for chat/gateway-driven admin mutations.
 */
describe("archestra tool audit records", () => {
  let testAgent: Agent;
  let organizationId: string;
  let adminUserId: string;
  let mockContext: ArchestraContext;

  beforeEach(async ({ makeAgent, makeUser, makeOrganization, makeMember }) => {
    const org = await makeOrganization();
    organizationId = org.id;
    const user = await makeUser();
    adminUserId = user.id;
    await makeMember(user.id, org.id, { role: "admin" });
    testAgent = await makeAgent({
      name: "Audit Test Agent",
      organizationId: org.id,
    });
    mockContext = {
      agent: { id: testAgent.id, name: testAgent.name },
      userId: user.id,
      organizationId: org.id,
    };
  });

  async function findRows(resourceType: string) {
    // the audit write is fire-and-forget; give it a beat to land
    await new Promise((r) => setTimeout(r, 100));
    const { data } = await AuditLogModel.findPaginated({
      organizationId,
      resourceType,
      limit: 20,
      offset: 0,
    });
    return data;
  }

  test("create_team writes team.created with the created id and after-state", async () => {
    const result = await executeArchestraTool(
      toolName("create_team"),
      { name: "Audit Eng", description: "eng" },
      mockContext,
    );
    expect(result.isError).toBe(false);

    const rows = await findRows("team");
    const row = rows.find((r) => r.action === "team.created");
    expect(row).toBeDefined();
    expect(row?.outcome).toBe("success");
    expect(row?.actorId).toBe(adminUserId);
    expect(row?.httpPath).toBe("mcp-tool:archestra__create_team");
    expect(row?.resourceId).toBeTruthy();
    expect(row?.before).toBeNull();
    expect(row?.after).toMatchObject({ name: "Audit Eng" });
  });

  test("edit_team writes team.updated with a before/after name diff", async () => {
    const team = await TeamModel.create({
      name: "Old Name",
      organizationId,
      createdBy: adminUserId,
    });

    const result = await executeArchestraTool(
      toolName("edit_team"),
      { id: team.id, name: "New Name" },
      mockContext,
    );
    expect(result.isError).toBe(false);

    const rows = await findRows("team");
    const row = rows.find((r) => r.action === "team.updated");
    expect(row?.resourceId).toBe(team.id);
    expect(row?.before).toMatchObject({ name: "Old Name" });
    expect(row?.after).toMatchObject({ name: "New Name" });
  });

  test("delete_team writes team.deleted with before-state and no after", async () => {
    const team = await TeamModel.create({
      name: "Doomed",
      organizationId,
      createdBy: adminUserId,
    });

    const result = await executeArchestraTool(
      toolName("delete_team"),
      { id: team.id },
      mockContext,
    );
    expect(result.isError).toBe(false);

    const rows = await findRows("team");
    const row = rows.find((r) => r.action === "team.deleted");
    expect(row?.resourceId).toBe(team.id);
    expect(row?.before).toMatchObject({ name: "Doomed" });
    expect(row?.after).toBeNull();
  });

  test("update_skill writes skill.updated resolving the target by name", async () => {
    const skill = await SkillModel.createWithFiles({
      skill: {
        organizationId,
        authorId: adminUserId,
        name: "audit-probe",
        description: "A skill for audit tests.",
        content: "# audit-probe\nOriginal instructions.",
        metadata: {},
        sourceType: "manual",
        scope: "personal",
      },
      files: [],
    });
    expect(skill).not.toBeNull();

    const updated = MANIFEST.replace(
      "Original instructions.",
      "Updated instructions.",
    );
    const result = await executeArchestraTool(
      toolName("update_skill"),
      { name: "audit-probe", content: updated },
      mockContext,
    );
    expect(result.isError).toBe(false);

    const rows = await findRows("skill");
    const row = rows.find((r) => r.action === "skill.updated");
    expect(row?.resourceId).toBe(skill?.id);
    expect(row?.before?.content).toContain("Original instructions.");
    expect(row?.after?.content).toContain("Updated instructions.");
  });

  test("create_skill writes skill.created and resolves the created row", async () => {
    const result = await executeArchestraTool(
      toolName("create_skill"),
      { content: MANIFEST },
      mockContext,
    );
    expect(result.isError).toBe(false);

    const rows = await findRows("skill");
    const row = rows.find((r) => r.action === "skill.created");
    expect(row?.outcome).toBe("success");
    expect(row?.resourceId).toBeTruthy();
    expect(row?.after).toMatchObject({ name: "audit-probe" });
  });

  test("a failed mutation writes an outcome=failure row", async () => {
    const result = await executeArchestraTool(
      toolName("edit_team"),
      { id: "00000000-0000-0000-0000-000000000000", name: "Nope" },
      mockContext,
    );
    expect(result.isError).toBe(true);

    const rows = await findRows("team");
    const row = rows.find((r) => r.action === "team.updated");
    expect(row?.outcome).toBe("failure");
    expect(row?.after).toBeNull();
  });

  test("read-only tools write no audit rows", async () => {
    const result = await executeArchestraTool(
      toolName("list_teams"),
      {},
      mockContext,
    );
    expect(result.isError).toBe(false);

    const rows = await findRows("team");
    expect(rows).toHaveLength(0);
  });
});
