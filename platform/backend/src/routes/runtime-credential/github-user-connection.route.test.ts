import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import db, { schema } from "@/database";
import { registerAuditLogHook } from "@/middleware/audit-log-hook";
import { RuntimeCredentialConnectionModel } from "@/models";
import { createFastifyInstance, type FastifyInstanceWithZod } from "@/server";
import {
  createRuntimeCredentialDefinition,
  setRuntimeCredentialConnection,
} from "@/services/agent-runtime/runtime-credentials";
import { resolveCredential } from "@/services/credentials";
import { afterEach, beforeEach, expect, test } from "@/test";
import { useMswServer as setupMswServer } from "@/test/msw";
import type { User } from "@/types";

const server = setupMswServer();
let app: FastifyInstanceWithZod;
let user: User;
let organizationId: string;
let clock = 0;
let exchanges: Record<string, string>[];

beforeEach(async ({ makeAdmin, makeOrganization, makeMember }) => {
  user = await makeAdmin();
  organizationId = (await makeOrganization()).id;
  await makeMember(user.id, organizationId, { role: "admin" });
  await createRuntimeCredentialDefinition({
    organizationId,
    userId: user.id,
    definition: {
      description: "",
      icon: null,
      key: "repository-app",
      name: "Repository App",
      kind: "github_app",
      allowPersonal: false,
      allowOrganization: true,
      githubUrl: "https://api.github.com",
      appId: "123",
      installationId: "456",
      githubClientId: "test-client",
    },
  });
  await setRuntimeCredentialConnection({
    organizationId,
    userId: user.id,
    credentialId: "repository-app",
    scope: "organization",
    value: JSON.stringify({
      privateKey: "test-private-key",
      clientSecret: "test-client-secret",
    }),
  });
  await createRuntimeCredentialDefinition({
    organizationId,
    userId: user.id,
    definition: {
      description: "",
      icon: null,
      key: "github-user",
      name: "GitHub",
      kind: "github_app_user",
      allowPersonal: true,
      allowOrganization: false,
      githubAppCredentialKey: "repository-app",
    },
  });
  app = createFastifyInstance();
  app.addHook("onRequest", async (request) => {
    request.user = user;
    request.organizationId = organizationId;
  });
  registerAuditLogHook(app);
  await app.register((await import("./runtime-credential.routes")).default);
  exchanges = [];
  clock = 0;
  server.use(
    http.post(
      "https://github.com/login/oauth/access_token",
      async ({ request }) => {
        exchanges.push((await request.json()) as Record<string, string>);
        return HttpResponse.json({
          access_token: `access-${++clock}`,
          refresh_token: `refresh-${clock}`,
          expires_in: 28800,
          refresh_token_expires_in: 15897600,
        });
      },
    ),
    http.get("https://api.github.com/user", ({ request }) => {
      expect(request.headers.get("authorization")).toBe("Bearer access-1");
      return HttpResponse.json({ id: 12345, login: "example-developer" });
    }),
  );
});
afterEach(async () => {
  await app.close();
});

test("connects the verified account once, binds PKCE, and resolves only its access token for every consumer", async () => {
  const url = await start();
  expect(url.origin).toBe("https://github.com");
  expect(url.searchParams.get("client_id")).toBe("test-client");
  const response = await complete(url);
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    id: "github-user",
    login: "example-developer",
    configured: true,
  });
  expect(
    createHash("sha256").update(exchanges[0].code_verifier).digest("base64url"),
  ).toBe(url.searchParams.get("code_challenge"));
  const owner = {
    organizationId,
    userId: user.id,
    credentialId: "github-user",
    scope: "personal" as const,
  };
  const credential = await resolveCredential(owner);
  expect(credential?.value).toBe("access-1");
  expect(credential?.expiresAt).toBeGreaterThan(Date.now());
  expect(
    await resolveCredential({ ...owner, userId: "another-user" }),
  ).toBeNull();
  expect(await resolveCredential({ ...owner, userId: null })).toBeNull();
  expect((await complete(url)).statusCode).toBe(400);
  expect(exchanges).toHaveLength(1);
  expect(response.body).not.toContain("access-1");
  expect(response.body).not.toContain("refresh-1");
  const [audit] = await db
    .select()
    .from(schema.auditLogsTable)
    .where(
      and(
        eq(schema.auditLogsTable.organizationId, organizationId),
        eq(schema.auditLogsTable.action, "credential.updated"),
      ),
    );
  expect(audit).toBeDefined();
  expect(audit.after).toMatchObject({
    credentialId: "github-user",
    scope: "personal",
  });
  expect(audit.after).not.toEqual(audit.before);
  expect(JSON.stringify(audit)).not.toMatch(
    /access-1|refresh-1|test-client-secret|test-code/,
  );
});

test("rejects state from another user and rejects manual token substitution", async ({
  makeUser,
}) => {
  const url = await start();
  const originalUser = user;
  user = await makeUser();
  expect((await complete(url)).statusCode).toBe(400);
  user = originalUser;
  expect((await complete(url)).statusCode).toBe(200);
  const manual = await app.inject({
    method: "PUT",
    url: "/api/credentials/github-user/personal",
    payload: { value: "forged-token" },
  });
  expect(manual.statusCode).toBe(400);
});

test("starting a new sign-in invalidates the previous authorization state", async () => {
  const previous = await start();
  const current = await start();
  expect((await complete(previous)).statusCode).toBe(400);
  expect(exchanges).toHaveLength(0);
  expect((await complete(current)).statusCode).toBe(200);
  expect(exchanges).toHaveLength(1);
});

test("rotates expiring tokens, preserves account binding, and disconnect cancels pending sign-in", async () => {
  await complete(await start());
  const owner = {
    organizationId,
    userId: user.id,
    credentialId: "github-user",
    scope: "personal" as const,
  };
  const stored = JSON.parse(
    (await RuntimeCredentialConnectionModel.resolveValue(owner)) ?? "null",
  );
  await RuntimeCredentialConnectionModel.upsert({
    ...owner,
    value: JSON.stringify({ ...stored, expiresAt: Date.now() - 1 }),
  });
  expect((await resolveCredential(owner))?.value).toBe("access-2");
  expect(exchanges[1]).toMatchObject({
    refresh_token: "refresh-1",
    grant_type: "refresh_token",
    client_id: "test-client",
  });
  const rotated = JSON.parse(
    (await RuntimeCredentialConnectionModel.resolveValue(owner)) ?? "null",
  );
  expect(rotated).toMatchObject({
    refreshToken: "refresh-2",
    githubId: 12345,
    login: "example-developer",
  });
  const pending = await start();
  expect(
    (
      await app.inject({
        method: "DELETE",
        url: "/api/credentials/github-user/personal",
      })
    ).statusCode,
  ).toBe(200);
  expect((await complete(pending)).statusCode).toBe(400);
  expect(await resolveCredential(owner)).toBeNull();
  const audits = await db
    .select()
    .from(schema.auditLogsTable)
    .where(eq(schema.auditLogsTable.organizationId, organizationId));
  expect(audits).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        action: "credential.updated",
        before: expect.objectContaining({
          credentialId: "github-user",
          scope: "personal",
        }),
        after: null,
      }),
    ]),
  );
  expect(JSON.stringify(audits)).not.toMatch(
    /access-2|refresh-2|test-client-secret/,
  );
});

test("parallel consumers refresh a shared user connection only once", async () => {
  await complete(await start());
  const owner = {
    organizationId,
    userId: user.id,
    credentialId: "github-user",
    scope: "personal" as const,
  };
  const stored = JSON.parse(
    (await RuntimeCredentialConnectionModel.resolveValue(owner)) ?? "null",
  );
  await RuntimeCredentialConnectionModel.upsert({
    ...owner,
    value: JSON.stringify({ ...stored, expiresAt: Date.now() - 1 }),
  });
  const values = await Promise.all([
    resolveCredential(owner),
    resolveCredential(owner),
  ]);
  expect(values.map((entry) => entry?.value)).toEqual(["access-2", "access-2"]);
  expect(exchanges).toHaveLength(2);
});

test("does not save tokens when GitHub cannot verify the user", async () => {
  server.use(
    http.get("https://api.github.com/user", () =>
      HttpResponse.json({ message: "Unauthorized" }, { status: 401 }),
    ),
  );
  expect((await complete(await start())).statusCode).toBe(502);
  expect(
    await resolveCredential({
      organizationId,
      userId: user.id,
      credentialId: "github-user",
      scope: "personal",
    }),
  ).toBeNull();
});

async function start() {
  const result = await app.inject({
    method: "POST",
    url: "/api/credentials/github-user/github/start",
  });
  expect(result.statusCode).toBe(200);
  return new URL(result.json().authorizationUrl);
}
async function complete(url: URL) {
  return app.inject({
    method: "POST",
    url: "/api/credentials/github/callback",
    payload: { state: url.searchParams.get("state"), code: "test-code" },
  });
}
