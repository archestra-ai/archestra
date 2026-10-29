import { and, count, eq, inArray } from "drizzle-orm";
import { describe, expect, vi } from "vitest";
import db, { schema } from "@/database";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import AuditLogModel from "@/models/audit-log";
import SkillModel from "@/models/skill";
import { test } from "@/test";
import {
  STUB_COMMIT_SHA,
  stubGithub,
  stubSkillManifest,
} from "@/test/github-skills-stub";
import type { InsertSkill } from "@/types";
import skillRoutes from "./skill.routes";
import { MANIFEST, useSkillRouteTestApp } from "./skill.test-helpers";

describe("PATCH /api/skills/:id/github-sync", () => {
  const ctx = useSkillRouteTestApp(async (app) => {
    registerAuditLogHook(app);
    await app.register(skillRoutes);
  });

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

  test("reconnects disconnected Git provenance through a verified full source and audits the change", async () => {
    const skill = await seedSynced({
      githubSyncInterval: null,
      githubSyncRef: null,
    });
    stubGithub([
      {
        owner: "route-reconnect",
        repo: "skills",
        files: {
          "synced-skill/SKILL.md": stubSkillManifest("synced-skill"),
          "synced-skill/reference.txt": "new resource bytes",
        },
      },
    ]);
    const response = await ctx.app.inject({
      method: "PATCH",
      url: `/api/skills/${skill.id}/github-sync`,
      payload: {
        interval: "1h",
        source: {
          repoUrl: "/route-reconnect/skills/tree/main",
          skillPath: "synced-skill",
        },
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      id: skill.id,
      sourceType: "github",
      sourceRef: "route-reconnect/skills@main:synced-skill",
      sourceCommit: STUB_COMMIT_SHA,
      githubSyncRef: "main",
      githubSyncInterval: "1h",
    });
    expect(response.json().content).toContain("# synced-skill");
    await vi.waitFor(async () => {
      const audit = await AuditLogModel.findPaginated({
        organizationId: ctx.organizationId,
        resourceId: skill.id,
        limit: 10,
        offset: 0,
      });
      expect(audit.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            action: "skill.updated",
            before: expect.objectContaining({ githubSyncInterval: null }),
            after: expect.objectContaining({
              githubSyncInterval: "1h",
              sourceCommit: STUB_COMMIT_SHA,
            }),
          }),
        ]),
      );
    });
  });

  test("a failed reconnect leaves the editable snapshot disconnected and unchanged", async () => {
    const skill = await seedSynced({
      githubSyncInterval: null,
      githubSyncRef: null,
    });
    stubGithub([
      {
        owner: "route-reconnect-missing",
        repo: "skills",
        files: { "elsewhere/SKILL.md": stubSkillManifest("elsewhere") },
      },
    ]);
    const response = await ctx.app.inject({
      method: "PATCH",
      url: `/api/skills/${skill.id}/github-sync`,
      payload: {
        source: {
          repoUrl: "/route-reconnect-missing/skills/tree/main",
          skillPath: "missing",
        },
      },
    });
    expect(response.statusCode, response.body).toBe(400);
    expect(await SkillModel.findById(skill.id)).toMatchObject({
      content: "# body",
      sourceRef: "acme/skills@main:synced-skill",
      sourceCommit: "abc",
      githubSyncInterval: null,
    });
  });

  test("does not convert manual or built-in skills through the reconnect path", async () => {
    for (const sourceType of ["manual", "built_in"] as const) {
      const skill = await seedSynced({
        name: `${sourceType}-snapshot`,
        sourceType,
        githubSyncInterval: null,
        githubSyncRef: null,
      });
      const response = await ctx.app.inject({
        method: "PATCH",
        url: `/api/skills/${skill.id}/github-sync`,
        payload: {
          source: {
            repoUrl: "/route-reconnect-rejected/skills/tree/main",
            skillPath: "synced-skill",
          },
        },
      });
      expect(response.statusCode, response.body).toBe(400);
      expect(await SkillModel.findById(skill.id)).toMatchObject({
        sourceType,
        githubSyncInterval: null,
        content: "# body",
      });
    }
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
