import { DEFAULT_CREDENTIAL_GRANTS } from "@archestra/shared";
import type { FastifyInstanceWithZod } from "@/fastify-instance";
import { createFastifyInstance } from "@/fastify-instance";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import ResourcePermissionPolicyModel from "@/models/resource-permission-policy";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { registerRoutePermissions } from "@/test/route-permissions";
import type { User } from "@/types";
import routes from "./runtime-credential.routes";

/**
 * Adding a credential for yourself is self-service, the way a personal LLM
 * provider key is: a member without `credential:create` may add one that
 * takes a personal value, and only they can reach it. Organization and shared
 * credentials still need the create permission.
 */
describe("POST /api/credentials", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let member: User;
  let otherMember: User;
  let editor: User;
  let caller: User;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    organizationId = (await makeOrganization()).id;
    member = await makeUser();
    await makeMember(member.id, organizationId, { role: "member" });
    otherMember = await makeUser();
    await makeMember(otherMember.id, organizationId, { role: "member" });
    editor = await makeUser();
    await makeMember(editor.id, organizationId, { role: "editor" });
    caller = member;

    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user: caller, organizationId });
    });
    registerRoutePermissions(app);
    registerAuditLogHook(app);
    await app.register(routes);
  });

  afterEach(async () => {
    await app.close();
  });

  const create = (payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: "/api/credentials", payload });

  const listedKeys = async (as: User, query = "") => {
    caller = as;
    const response = await app.inject({ url: `/api/credentials${query}` });
    expect(response.statusCode, response.body).toBe(200);
    return response.json().map((entry: { key: string }) => entry.key);
  };

  const personal = {
    key: "my-token",
    name: "My token",
    kind: "secret",
    allowPersonal: true,
    allowOrganization: false,
  };

  test("GitLab credential host survives create, list and update", async () => {
    const created = await create({
      ...personal,
      key: "gitlab-test-token",
      kind: "gitlab_token",
      gitlabUrl: "https://gitlab.example.invalid",
    });
    expect(created.statusCode, created.body).toBe(200);
    expect(created.json().gitlabUrl).toBe("https://gitlab.example.invalid");

    const listed = await app.inject({ url: "/api/credentials" });
    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json()).toEqual([
      expect.objectContaining({
        key: "gitlab-test-token",
        gitlabUrl: "https://gitlab.example.invalid",
      }),
    ]);

    const updated = await app.inject({
      method: "PATCH",
      url: "/api/credentials/gitlab-test-token",
      payload: { gitlabUrl: "https://updated.gitlab.example.invalid" },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json().gitlabUrl).toBe(
      "https://updated.gitlab.example.invalid",
    );
    const refreshed = await app.inject({ url: "/api/credentials" });
    expect(refreshed.statusCode, refreshed.body).toBe(200);
    expect(refreshed.json()[0].gitlabUrl).toBe(
      "https://updated.gitlab.example.invalid",
    );
    expect(await listedKeys(otherMember)).not.toContain("gitlab-test-token");
  });

  test("a member adds a credential only they can reach", async () => {
    const created = await create(personal);
    expect(created.statusCode, created.body).toBe(200);

    // Its author has full access: they connect a value, edit, and delete it.
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/api/credentials/my-token/personal",
          payload: { value: "s3cret" },
        })
      ).statusCode,
    ).toBe(200);
    const renamed = await app.inject({
      method: "PATCH",
      url: "/api/credentials/my-token",
      payload: { name: "Renamed" },
    });
    expect(renamed.statusCode, renamed.body).toBe(200);
    expect(await listedKeys(member)).toEqual(["my-token"]);

    // Nobody else reaches it through a grant. Editors manage every
    // credential, so it shows for them only under "Admin access".
    expect(await listedKeys(otherMember)).not.toContain("my-token");
    expect(await listedKeys(editor, "?access=mine,shared,org")).not.toContain(
      "my-token",
    );
    expect(await listedKeys(editor, "?access=others")).toContain("my-token");

    caller = member;
    expect(
      (await app.inject({ method: "DELETE", url: "/api/credentials/my-token" }))
        .statusCode,
    ).toBe(200);
  });

  test("a member cannot add organization or shared credentials", async () => {
    const organizationScoped = await create({
      ...personal,
      key: "org-token",
      allowPersonal: false,
      allowOrganization: true,
    });
    expect(organizationScoped.statusCode).toBe(403);
    expect(organizationScoped.json().error.message).toContain(
      "credential:create",
    );

    const shared = await create({
      ...personal,
      key: "shared-token",
      initialGrants: [
        { subject: { type: "user", id: otherMember.id }, actions: ["read"] },
      ],
    });
    expect(shared.statusCode).toBe(403);

    // Leaving the scope to schema defaults is refused too.
    const unscoped = await create({
      key: "unscoped-token",
      name: "Unscoped token",
      kind: "secret",
    });
    expect(unscoped.statusCode).toBe(403);

    const githubApp = await create({
      key: "repository-app",
      name: "Repository app",
      kind: "github_app",
      githubUrl: "https://api.github.com",
      appId: "123",
      installationId: "456",
      allowPersonal: false,
      allowOrganization: true,
    });
    expect(githubApp.statusCode).toBe(403);

    expect(await listedKeys(member)).toEqual([]);
  });

  test("with credential:create, omitting grants still shares it with everyone", async () => {
    caller = editor;
    const created = await create({ ...personal, key: "team-token" });
    expect(created.statusCode, created.body).toBe(200);
    const policy = await ResourcePermissionPolicyModel.find({
      organizationId,
      resource: "credential",
      scope: created.json().id,
    });
    expect(policy?.grants).toEqual(
      expect.arrayContaining(DEFAULT_CREDENTIAL_GRANTS),
    );
    expect(await listedKeys(otherMember)).toContain("team-token");
  });
});
