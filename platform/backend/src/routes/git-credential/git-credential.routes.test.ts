import { ADMIN_ROLE_NAME } from "@archestra/shared";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import AuditLogModel from "@/models/audit-log";
import { beforeEach, describe, expect, test } from "@/test";
import { FakeGitlab } from "@/test/fake-gitlab";
import { useMswServer } from "@/test/msw";
import { registerRoutePermissions } from "@/test/route-permissions";
import routes from "./git-credential.routes";

// biome-ignore lint/correctness/useHookAtTopLevel: Vitest lifecycle fixture, not a React hook
const server = useMswServer();
const GITLAB = "https://gitlab.example.test";
const TOKEN = "glpat-credential-routes";

// Only HTTP to GitLab is faked: RBAC, secret storage, and audit run for real.
describe("Git credential routes", () => {
  let app: FastifyInstanceWithZod;
  let organizationId: string;
  let gitlab: FakeGitlab;

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    organizationId = (await makeOrganization()).id;
    const user = await makeUser();
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });
    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user, organizationId });
    });
    registerAuditLogHook(app);
    registerRoutePermissions(app);
    await app.register(routes);
    gitlab = new FakeGitlab(GITLAB, TOKEN);
    server.use(...gitlab.handlers());
  });

  test("saves a GitLab token, audits it without the token, and lists what it reaches", async () => {
    gitlab.addGroup("platform/security");
    gitlab.addProject({
      path: "platform/security/skill-hub",
      files: { "README.md": "# Hub" },
    });

    const created = await app.inject({
      method: "POST",
      url: "/api/git-credentials/gitlab",
      payload: { name: "Self-managed", gitlabUrl: GITLAB, token: TOKEN },
    });
    expect(created.statusCode, created.body).toBe(200);
    const credential = created.json();
    expect(credential).toMatchObject({
      name: "Self-managed",
      provider: "gitlab",
      kind: "gitlab_token",
      webUrl: GITLAB,
    });
    expect(created.body).not.toContain(TOKEN);

    const listed = await app.inject({
      method: "GET",
      url: "/api/git-credentials",
    });
    expect(listed.json()).toEqual([
      expect.objectContaining({ id: credential.id, provider: "gitlab" }),
    ]);
    const namespaces = await app.inject({
      method: "GET",
      url: `/api/git-credentials/${credential.id}/namespaces`,
    });
    expect(namespaces.json()).toEqual(["", "platform/security"]);
    const repositories = await app.inject({
      method: "GET",
      url: `/api/git-credentials/${credential.id}/repositories`,
    });
    expect(repositories.json()).toEqual([
      expect.objectContaining({ path: "platform/security/skill-hub" }),
    ]);

    const { data: audit } = await AuditLogModel.findPaginated({
      organizationId,
      resourceType: "credential",
      sortDirection: "asc",
      limit: 10,
      offset: 0,
    });
    expect(audit.map((row) => row.action)).toEqual(["credential.created"]);
    expect(audit[0].after).toMatchObject({ name: "Self-managed" });
    expect(JSON.stringify(audit[0])).not.toContain(TOKEN);
  });

  test("refuses a token GitLab rejects and saves nothing", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/git-credentials/gitlab",
      payload: { name: "Wrong", gitlabUrl: GITLAB, token: "glpat-wrong" },
    });

    expect(response.statusCode).toBe(400);
    const listed = await app.inject({
      method: "GET",
      url: "/api/git-credentials",
    });
    expect(listed.json()).toEqual([]);
  });
});
