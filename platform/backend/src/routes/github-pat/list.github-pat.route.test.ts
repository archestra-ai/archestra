import { ADMIN_ROLE_NAME } from "@archestra/shared";
import type { FastifyInstanceWithZod } from "@/server";
import { createGithubPat } from "@/services/github-pat";
import { afterEach, describe, expect, test } from "@/test";
import { buildGithubPatTestApp } from "./github-pat.test-helpers";

describe("GET /api/github-pats", () => {
  let app: FastifyInstanceWithZod;

  afterEach(async () => {
    if (app) await app.close();
  });

  test("lists the org's tokens without values, newest first", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const user = await makeUser();
    const organization = await makeOrganization();
    const otherOrg = await makeOrganization();
    await makeMember(user.id, organization.id, { role: ADMIN_ROLE_NAME });
    app = await buildGithubPatTestApp(user, organization.id);

    await createGithubPat({
      organizationId: organization.id,
      data: { name: "mine", token: "ghp_mine" },
    });
    await createGithubPat({
      organizationId: otherOrg.id,
      data: { name: "other-org", token: "ghp_other" },
    });

    const listed = await app.inject({ method: "GET", url: "/api/github-pats" });
    expect(listed.statusCode).toBe(200);
    const body = listed.json();
    expect(body).toHaveLength(1);
    expect(body[0].name).toBe("mine");
    expect(body[0].secretId).toBeUndefined();
    expect(body[0].token).toBeUndefined();
  });
});
