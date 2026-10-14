// Synthetic identity-provider fixtures for local previews and integration tests.
import { HttpResponse, http } from "msw";
import { makeConfig, makePublicConfig } from "@/mocks/data/config";
import { largeSignIn } from "./data/idp-sign-in";

const provider = {
  id: "00000000-0000-4000-8000-000000000085",
  providerId: "Okta",
  name: "Okta",
  issuer: "https://idp.example.test",
  domain: "example.test",
  ssoLoginEnabled: true,
  organizationId: "test-org",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  oidcConfig: {
    issuer: "https://idp.example.test",
    clientId: "synthetic-client",
    clientSecret: "",
    discoveryEndpoint:
      "https://idp.example.test/.well-known/openid-configuration",
    scopes: ["openid", "email", "profile", "groups"],
    pkce: true,
    mapping: { id: "sub", email: "email", name: "name" },
  },
  roleMapping: {
    rules: [
      {
        expression: '{{#includes groups "platform-admins"}}true{{/includes}}',
        role: "admin",
      },
      {
        expression: '{{#includes groups "engineering"}}true{{/includes}}',
        role: "member",
      },
    ],
    defaultRole: "member",
    strictMode: false,
    skipRoleSync: false,
  },
  teamSyncConfig: { enabled: true, groupsExpression: "" },
  configuredSecretPaths: [],
};
export const identityProviderHandlers = [
  http.get("/api/roles", () =>
    HttpResponse.json({
      data: [
        {
          id: "admin",
          role: "admin",
          name: "Admin",
          predefined: true,
          permission: {},
        },
        {
          id: "member",
          role: "member",
          name: "Member",
          predefined: true,
          permission: {},
        },
        {
          id: "editor",
          role: "editor",
          name: "Editor",
          predefined: true,
          permission: {},
        },
        {
          id: "auditor",
          role: "auditor",
          name: "Auditor",
          predefined: false,
          permission: {},
        },
        {
          id: "developer",
          role: "developer",
          name: "Developer",
          predefined: false,
          permission: {},
        },
      ],
      pagination: {
        currentPage: 1,
        limit: 100,
        total: 5,
        totalPages: 1,
        hasNext: false,
        hasPrev: false,
      },
    }),
  ),
  http.get("/api/config", () =>
    HttpResponse.json(
      makeConfig({
        enterpriseFeatures: { core: true },
        smallTeamTier: { communicate: false },
      }),
    ),
  ),
  http.get("/api/config/public", () =>
    HttpResponse.json(makePublicConfig({ enterpriseCoreActive: true })),
  ),
  http.get("/api/identity-providers", () => HttpResponse.json([provider])),
  http.get("/api/identity-providers/:id/latest-id-token-claims", () =>
    HttpResponse.json({
      providerId: "Okta",
      claims:
        typeof window !== "undefined" &&
        new URL(window.location.href).searchParams.get("preview-sign-in") ===
          "missing"
          ? null
          : largeSignIn,
      accessTokenClaims: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    }),
  ),
  http.get("/api/identity-providers/:id", () => HttpResponse.json(provider)),
  http.put("/api/identity-providers/:id", async ({ request }) => {
    Object.assign(provider, (await request.json()) as Partial<typeof provider>);
    return HttpResponse.json(provider);
  }),
  ...[http.post, http.patch, http.delete].flatMap((method) =>
    ["/api/identity-providers", "/api/identity-providers/:id"].map((path) =>
      method(path, () =>
        HttpResponse.json(
          { error: "Saving is disabled in the local design preview" },
          { status: 409 },
        ),
      ),
    ),
  ),
];
