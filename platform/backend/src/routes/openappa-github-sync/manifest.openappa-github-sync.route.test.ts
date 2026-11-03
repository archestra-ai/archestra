import { ADMIN_ROLE_NAME } from "@archestra/shared";
import { HttpResponse, http } from "msw";
import config from "@/config";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import { registerRoutePermissions } from "@/test/route-permissions";
import routes from "./openappa-github-sync.routes";

// biome-ignore lint/correctness/useHookAtTopLevel: Vitest lifecycle fixture, not a React hook
const server = useMswServer();

describe("POST /api/openappa/github-app/manifest", () => {
  let app: FastifyInstanceWithZod;
  const original = {
    openappa: config.openappa.enabled,
    core: config.enterpriseFeatures.core,
  };

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    const organizationId = (await makeOrganization()).id;
    const user = await makeUser();
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });
    config.openappa.enabled = true;
    config.enterpriseFeatures.core = true;
    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user, organizationId });
    });
    registerRoutePermissions(app);
    await app.register(routes);
  });

  afterEach(async () => {
    config.openappa.enabled = original.openappa;
    config.enterpriseFeatures.core = original.core;
    await app.close();
  });

  const start = (owner: string) =>
    app.inject({
      method: "POST",
      url: "/api/openappa/github-app/manifest",
      payload: { githubUrl: "https://github.com", owner },
    });

  test("takes an organization GitHub hides behind its enterprise's sign-in", async () => {
    // Anonymous API reads of an Enterprise Managed Users organization get a
    // 404, as for a missing account; only its web profile tells them apart.
    const redirect = (location: string) => () =>
      new HttpResponse(null, { status: 302, headers: { location } });
    server.use(
      http.get("https://api.github.com/users/:login", () =>
        HttpResponse.json({ message: "Not Found" }, { status: 404 }),
      ),
      http.head(
        "https://github.com/managed-org",
        redirect(
          "https://github.com/enterprises/acme/sso?return_to=https%3A%2F%2Fgithub.com%2Fmanaged-org",
        ),
      ),
      http.head(
        "https://github.com/offsite-org",
        redirect("https://example.com/enterprises/acme/sso"),
      ),
      http.head(
        "https://github.com/no-such-org",
        () => new HttpResponse(null, { status: 404 }),
      ),
      http.head(
        "https://github.com/down-org",
        () => new HttpResponse(null, { status: 503 }),
      ),
    );

    const managed = await start("managed-org");
    expect(managed.statusCode, managed.body).toBe(200);
    expect(new URL(managed.json().url).pathname).toBe(
      "/organizations/managed-org/settings/apps/new",
    );

    for (const owner of ["no-such-org", "offsite-org"]) {
      const missing = await start(owner);
      expect(missing.statusCode, owner).toBe(400);
      expect(missing.json().error.message).toBe(
        `GitHub has no account named ${owner}.`,
      );
    }
    const unanswered = await start("down-org");
    expect(unanswered.statusCode).toBe(502);
    expect(unanswered.json().error.message).toBe(
      "GitHub didn't return the down-org account.",
    );
  });
});
