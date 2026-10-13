import { generateKeyPairSync, randomUUID } from "node:crypto";
import { ADMIN_ROLE_NAME } from "@archestra/shared";
import { HttpResponse, http } from "msw";
import config from "@/config";
import {
  createFastifyInstance,
  type FastifyInstanceWithZod,
} from "@/fastify-instance";
import RuntimeCredentialConnectionModel from "@/models/runtime-credential-connection";
import RuntimeCredentialDefinitionModel from "@/models/runtime-credential-definition";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import { registerRoutePermissions } from "@/test/route-permissions";
import routes from "./openappa-github-sync.routes";

// biome-ignore lint/correctness/useHookAtTopLevel: Vitest lifecycle fixture, not a React hook
const server = useMswServer();
const API = "https://api.github.com";
const REPO = `${API}/repos/example/policies`;

describe("GET /api/openappa/github-app/repository", () => {
  let app: FastifyInstanceWithZod;
  let credentialId: string;
  let installationId: string;
  /** Paths of the HEAD requests setup made, so a test can tell what it checked. */
  let heads: string[];

  beforeEach(async ({ makeOrganization, makeUser, makeMember }) => {
    const organizationId = (await makeOrganization()).id;
    const user = await makeUser();
    await makeMember(user.id, organizationId, { role: ADMIN_ROLE_NAME });
    config.openappa.enabled = true;
    // A fresh installation per test, so a cached token never answers for another.
    installationId = String(Math.floor(Math.random() * 1e9));
    const key = `github-app-${randomUUID()}`;
    credentialId = (
      await RuntimeCredentialDefinitionModel.create({
        organizationId,
        createdBy: user.id,
        definition: {
          key,
          name: "OpenAPPA Sync",
          kind: "github_app",
          description: "",
          icon: null,
          githubUrl: API,
          appId: "123",
          installationId,
          allowPersonal: false,
          allowOrganization: true,
        },
      })
    ).id;
    const { privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    await RuntimeCredentialConnectionModel.upsert({
      organizationId,
      scope: "organization",
      userId: null,
      credentialId: key,
      value: privateKey,
    });
    heads = [];
    app = createFastifyInstance();
    app.addHook("onRequest", async (request) => {
      Object.assign(request, { user, organizationId });
    });
    registerRoutePermissions(app);
    await app.register(routes);
    server.use(
      http.post(
        `${API}/app/installations/${installationId}/access_tokens`,
        () =>
          HttpResponse.json({
            token: "test-installation-token",
            expires_at: new Date(Date.now() + 3600000).toISOString(),
          }),
      ),
    );
  });
  afterEach(async () => {
    await app.close();
  });

  /** A repository GitHub describes as `repository`, with `commits` its commits answer and `present` the paths that exist. */
  function github(params: {
    repository?: Record<string, unknown>;
    commits?: number;
    present?: string[];
  }) {
    server.use(
      http.get(REPO, () =>
        HttpResponse.json({ private: true, ...params.repository }),
      ),
      http.get(
        `${REPO}/commits`,
        () => new HttpResponse(null, { status: params.commits ?? 200 }),
      ),
      ...["appa.toml", "traces", "checks", "guardrails/appa.toml"].map((path) =>
        http.head(`${REPO}/contents/${path}`, ({ request }) => {
          heads.push(`${path}${new URL(request.url).search}`);
          return new HttpResponse(null, {
            status: params.present?.includes(path) ? 200 : 404,
          });
        }),
      ),
    );
  }

  const status = (query: Record<string, string | undefined> = {}) =>
    app.inject({
      method: "GET",
      url: "/api/openappa/github-app/repository",
      query: { credentialId, repo: "example/policies", ...query },
    });

  test("a private, unchanged template copy is ready to seed without reading its files", async () => {
    github({
      repository: {
        template_repository: { full_name: "Archestra-AI/OpenAPPA-Config" },
      },
    });
    const response = await status();
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ status: "template", validations: null });
    expect(heads).toEqual([]);
  });

  test.each([
    { name: "a public copy", repository: { private: false }, query: {} },
    {
      name: "a policy kept on a branch",
      repository: {},
      query: { ref: "dev" },
    },
    {
      name: "a policy at another path",
      repository: {},
      query: { path: "guardrails/appa.toml" },
    },
    {
      name: "validations kept elsewhere",
      repository: {},
      query: { validationDirectory: "checks" },
    },
  ])("$name of the template is read like any repository", async ({
    repository,
    query,
  }) => {
    github({
      repository: {
        template_repository: { full_name: "archestra-ai/openappa-config" },
        ...repository,
      },
    });
    const response = await status(query);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().status).toBe("other");
    expect(heads.length).toBe(2);
  });

  test("a repository without commits is empty, whatever it was generated from", async () => {
    github({
      repository: {
        template_repository: { full_name: "archestra-ai/openappa-config" },
      },
      commits: 409,
    });
    const response = await status();
    expect(response.json()).toEqual({ status: "empty", validations: null });
    expect(heads).toEqual([]);
  });

  test.each([
    {
      present: ["appa.toml", "traces"],
      expected: { status: "policy", validations: true },
    },
    {
      present: ["appa.toml"],
      expected: { status: "policy", validations: false },
    },
    { present: ["traces"], expected: { status: "other", validations: true } },
    { present: [], expected: { status: "other", validations: false } },
  ])("reports the policy file and validations folder it finds: $present", async ({
    present,
    expected,
  }) => {
    github({ present });
    const response = await status();
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual(expected);
    expect(heads.sort()).toEqual(["appa.toml", "traces"]);
  });

  test("checks the requested path and folder at the requested ref", async () => {
    github({ present: ["guardrails/appa.toml", "checks"] });
    const response = await status({
      ref: "policy/main",
      path: "guardrails/appa.toml",
      validationDirectory: "checks",
    });
    expect(response.json()).toEqual({ status: "policy", validations: true });
    expect(heads.sort()).toEqual([
      "checks?ref=policy%2Fmain",
      "guardrails/appa.toml?ref=policy%2Fmain",
    ]);
  });

  test("a repository the App cannot read is unreachable", async () => {
    server.use(http.get(REPO, () => new HttpResponse(null, { status: 404 })));
    const response = await status();
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      status: "unreachable",
      validations: null,
    });
  });

  test("an App that cannot sign in to GitHub is reported apart from the repository", async () => {
    server.use(
      http.post(
        `${API}/app/installations/${installationId}/access_tokens`,
        () =>
          HttpResponse.json({ message: "Bad credentials" }, { status: 401 }),
      ),
    );
    const response = await status();
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ status: "app_error", validations: null });
  });

  test("an unknown App is not found", async () => {
    const response = await status({ credentialId: randomUUID() });
    expect(response.statusCode).toBe(404);
  });
});
