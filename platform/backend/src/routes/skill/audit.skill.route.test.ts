import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import AuditLogModel from "@/models/audit-log";
import type { FastifyInstanceWithZod } from "@/server";
import { createFastifyInstance } from "@/server";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import type { User } from "@/types";
import skillRoutes from "./skill.routes";
import { MANIFEST } from "./skill.test-helpers";

/**
 * Skill edits carried entirely by child tables (resource files in
 * `skill_files`, teams in `skill_team`) are audited through the parent skill
 * snapshot ("parent carries the signal" in AUDIT_DECISIONS). These tests
 * exercise the real audit hook end-to-end and pin that such edits produce a
 * skill.updated row whose before/after actually differ.
 */
describe("skill routes — audit records", () => {
  let app: FastifyInstanceWithZod;
  let user: User;
  let organizationId: string;

  beforeEach(async ({ makeUser, makeOrganization }) => {
    user = await makeUser();
    organizationId = (await makeOrganization()).id;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user, organizationId });
    });
    registerAuditLogHook(app);
    await app.register(skillRoutes);
  });

  afterEach(async () => {
    await app.close();
  });

  async function findSkillAuditRows(resourceId: string) {
    // The audit write is fire-and-forget; give it a beat to land.
    await new Promise((r) => setTimeout(r, 50));
    const { data } = await AuditLogModel.findPaginated({
      organizationId,
      resourceType: "skill",
      limit: 20,
      offset: 0,
    });
    return data.filter((row) => row.resourceId === resourceId);
  }

  test("a file-only edit writes skill.updated with a files diff", async () => {
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/skills",
        payload: {
          content: MANIFEST,
          files: [{ path: "references/GUIDE.md", content: "guide v1" }],
        },
      })
    ).json();

    const response = await app.inject({
      method: "PUT",
      url: `/api/skills/${created.id}`,
      payload: {
        content: MANIFEST,
        files: [{ path: "references/GUIDE.md", content: "guide v2" }],
      },
    });
    expect(response.statusCode).toBe(200);

    const rows = await findSkillAuditRows(created.id);
    const updated = rows.find((row) => row.action === "skill.updated");
    expect(updated).toBeDefined();
    expect(updated?.outcome).toBe("success");
    expect(updated?.before).not.toBeNull();
    expect(updated?.after).not.toBeNull();
    // The SKILL.md body did not change — the resource file did. The snapshot
    // must carry that signal, or the row diffs as a bare latestVersion bump.
    expect(updated?.before?.content).toEqual(updated?.after?.content);
    expect(updated?.before?.files).not.toEqual(updated?.after?.files);
    expect(updated?.after?.files).toHaveLength(1);
    expect((updated?.after?.files as string[])[0]).toMatch(
      /^references\/GUIDE\.md \(\d+ bytes, sha256:[0-9a-f]{12}\)$/,
    );
  });

  test("adding a resource file surfaces in the files diff", async () => {
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/skills",
        payload: { content: MANIFEST },
      })
    ).json();

    const response = await app.inject({
      method: "PUT",
      url: `/api/skills/${created.id}`,
      payload: {
        content: MANIFEST,
        files: [{ path: "scripts/run.py", content: "print(1)" }],
      },
    });
    expect(response.statusCode).toBe(200);

    const rows = await findSkillAuditRows(created.id);
    const updated = rows.find((row) => row.action === "skill.updated");
    expect(updated?.before?.files).toEqual([]);
    expect(updated?.after?.files).toHaveLength(1);
  });
});
