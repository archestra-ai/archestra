import { and, count, eq, inArray } from "drizzle-orm";
import db, { schema } from "@/database";
import { SkillModel } from "@/models";
import { describe, expect, test, useRouteTestApp } from "@/test";
import type { InsertSkill } from "@/types";
import skillRoutes from "./skill.routes";
import { MANIFEST } from "./skill.test-helpers";

describe("PATCH /api/skills/:id/github-sync", () => {
  const ctx = useRouteTestApp(skillRoutes);

  async function seedSynced(overrides: Partial<InsertSkill> = {}) {
    const skill = await SkillModel.createWithFiles({
      skill: {
        organizationId: ctx.organizationId,
        authorId: ctx.user.id,
        name: "synced-skill",
        description: "synced",
        content: "# body",
        metadata: {},
        sourceType: "github",
        sourceRef: "acme/skills@main:synced-skill",
        sourceCommit: "abc",
        scope: "personal",
        githubSyncInterval: "1d",
        githubSyncRef: "main",
        ...overrides,
      },
      files: [],
    });
    if (!skill) throw new Error("seed failed");
    return skill;
  }

  test("changes the pull frequency", async () => {
    const skill = await seedSynced();
    const response = await ctx.app.inject({
      method: "PATCH",
      url: `/api/skills/${skill.id}/github-sync`,
      payload: { interval: "15m" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().githubSyncInterval).toBe("15m");
  });

  test("disconnect clears sync state but keeps content and provenance", async () => {
    const skill = await seedSynced();
    const response = await ctx.app.inject({
      method: "PATCH",
      url: `/api/skills/${skill.id}/github-sync`,
      payload: { disconnect: true },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.githubSyncInterval).toBeNull();
    expect(body.githubSyncRef).toBeNull();
    expect(body.sourceType).toBe("github");
    expect(body.sourceRef).toBe("acme/skills@main:synced-skill");
    expect(body.content).toBe("# body");

    // a disconnected skill is editable again
    const update = await ctx.app.inject({
      method: "PUT",
      url: `/api/skills/${skill.id}`,
      payload: { content: MANIFEST },
    });
    expect(update.statusCode).toBe(200);
  });

  test("syncNow enqueues one sync task, deduping in-flight pulls", async () => {
    const skill = await seedSynced();
    for (let i = 0; i < 2; i++) {
      const response = await ctx.app.inject({
        method: "PATCH",
        url: `/api/skills/${skill.id}/github-sync`,
        payload: { syncNow: true },
      });
      expect(response.statusCode).toBe(200);
    }
    const [row] = await db
      .select({ count: count() })
      .from(schema.tasksTable)
      .where(
        and(
          eq(schema.tasksTable.taskType, "skill_github_sync"),
          inArray(schema.tasksTable.status, ["pending", "processing"]),
        ),
      );
    expect(row?.count).toBe(1);
  });

  test("rejects a skill that is not synced", async () => {
    const skill = await seedSynced({
      githubSyncInterval: null,
      githubSyncRef: null,
    });
    const response = await ctx.app.inject({
      method: "PATCH",
      url: `/api/skills/${skill.id}/github-sync`,
      payload: { interval: "1h" },
    });
    expect(response.statusCode).toBe(400);
  });

  test("rejects passing more than one action", async () => {
    const skill = await seedSynced();
    const response = await ctx.app.inject({
      method: "PATCH",
      url: `/api/skills/${skill.id}/github-sync`,
      payload: { interval: "1h", syncNow: true },
    });
    expect(response.statusCode).toBe(400);
  });
});
