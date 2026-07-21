import { ADMIN_ROLE_NAME } from "@archestra/shared";
import GithubPatModel from "@/models/github-pat";
import SkillModel from "@/models/skill";
import { secretManager } from "@/secrets-manager";
import type { FastifyInstanceWithZod } from "@/server";
import { createGithubPat } from "@/services/github-pat";
import { afterEach, describe, expect, test } from "@/test";
import { buildGithubPatTestApp } from "./github-pat.test-helpers";

describe("DELETE /api/github-pats/:id", () => {
  let app: FastifyInstanceWithZod;

  afterEach(async () => {
    if (app) await app.close();
  });

  test("deletes the token and its secret", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const user = await makeUser();
    const organization = await makeOrganization();
    await makeMember(user.id, organization.id, { role: ADMIN_ROLE_NAME });
    app = await buildGithubPatTestApp(user, organization.id);

    const created = await createGithubPat({
      organizationId: organization.id,
      data: { name: "doomed", token: "ghp_x" },
    });
    const stored = await GithubPatModel.findByIdForOrganization({
      id: created.id,
      organizationId: organization.id,
    });
    const secretId = stored?.secretId;
    if (!secretId) throw new Error("expected a stored secret id");

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/github-pats/${created.id}`,
    });
    expect(deleted.statusCode).toBe(200);
    expect(await secretManager().getSecret(secretId)).toBeNull();
    expect(
      await GithubPatModel.findByIdForOrganization({
        id: created.id,
        organizationId: organization.id,
      }),
    ).toBeNull();
  });

  test("409s while a synced skill authenticates with it; deletable after disconnect", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const user = await makeUser();
    const organization = await makeOrganization();
    await makeMember(user.id, organization.id, { role: ADMIN_ROLE_NAME });
    app = await buildGithubPatTestApp(user, organization.id);

    const created = await createGithubPat({
      organizationId: organization.id,
      data: { name: "in-use", token: "ghp_x" },
    });
    const skill = await SkillModel.createWithFiles({
      skill: {
        organizationId: organization.id,
        authorId: null,
        name: "pat-synced",
        description: "synced via stored PAT",
        content: "# body",
        metadata: {},
        sourceType: "github",
        sourceRef: "acme/skills@main:pat-synced",
        sourceCommit: "abc",
        scope: "org",
        githubSyncInterval: "1d",
        githubPatId: created.id,
      },
      files: [],
    });
    if (!skill) throw new Error("seed failed");

    const blocked = await app.inject({
      method: "DELETE",
      url: `/api/github-pats/${created.id}`,
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json().error.message).toContain("synced skill");

    // disconnecting the skill releases the token
    await SkillModel.setGithubSync(skill.id, null);
    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/github-pats/${created.id}`,
    });
    expect(deleted.statusCode).toBe(200);
  });
});
