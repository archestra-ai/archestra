import type { archestraApiTypes } from "@archestra/shared";

// Shape derived from what `WithAuthCheck` and downstream hooks read —
// Better-Auth's session is not part of the Archestra SDK codegen.
type SessionResponse = {
  session: {
    id: string;
    userId: string;
    expiresAt: string;
    token: string;
    createdAt: string;
    updatedAt: string;
    ipAddress: string;
    userAgent: string;
    activeOrganizationId: string;
  };
  user: {
    id: string;
    email: string;
    name: string;
    role: string;
    emailVerified: boolean;
    createdAt: string;
    updatedAt: string;
    image: string | null;
    twoFactorEnabled: boolean;
  };
};

export function makeSession(
  overrides: {
    session?: Partial<SessionResponse["session"]>;
    user?: Partial<SessionResponse["user"]>;
  } = {},
): SessionResponse {
  return {
    session: {
      id: "test-session",
      userId: "test-user-admin",
      expiresAt: "2099-12-31T00:00:00.000Z",
      token: "test-session-token",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      ipAddress: "127.0.0.1",
      userAgent: "playwright",
      activeOrganizationId: "test-org",
      ...overrides.session,
    },
    user: {
      id: "test-user-admin",
      email: "admin@test.local",
      name: "Test Admin",
      role: "admin",
      emailVerified: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      image: null,
      twoFactorEnabled: false,
      ...overrides.user,
    },
  };
}

export const sessionSeed = makeSession();

/** Permissions map; defaults to full admin so every affordance renders. */
export function makeUserPermissions(
  overrides: Partial<archestraApiTypes.GetUserPermissionsResponses["200"]> = {},
): archestraApiTypes.GetUserPermissionsResponses["200"] {
  const ALL = ["read", "create", "update", "delete"] as const;
  return {
    mcpRegistry: [...ALL],
    mcpServerInstallation: [...ALL],
    mcpGateway: [...ALL],
    environment: ["read", "create", "update", "delete"],
    agent: [...ALL],
    agentTrigger: [...ALL],
    skill: [...ALL],
    plugin: [...ALL],
    chat: [...ALL],
    team: [...ALL],
    member: [...ALL],
    apiKey: [...ALL],
    llmProxy: ["read", "update"],
    llmProviderApiKey: [...ALL],
    llmVirtualKey: [...ALL],
    llmOauthClient: [...ALL],
    mcpOauthClient: [...ALL],
    llmModel: [...ALL],
    llmLimit: [...ALL],
    llmCost: [...ALL],
    toolPolicy: [...ALL],
    organizationSettings: [...ALL],
    knowledgeSettings: [...ALL],
    knowledgeSource: [...ALL],
    agentSettings: [...ALL],
    llmSettings: [...ALL],
    log: [...ALL],
    ac: [...ALL],
    identityProvider: [...ALL],
    secret: [...ALL],
    scheduledTask: [...ALL],
    ...overrides,
  };
}

export const adminPermissionsSeed = makeUserPermissions();

/**
 * The admin role's grants at `*` — managing every object of each kind, which
 * the retired `admin` role actions became. Listed by hand: the shared barrel
 * cannot be imported into the MSW handlers.
 */
export const adminScopedCapabilitiesSeed: archestraApiTypes.GetScopedCapabilitiesResponses["200"] =
  [
    "agent",
    "mcpGateway",
    "mcpRegistry",
    "skill",
    "app",
    "llmModel",
    "project",
    "plugin",
    "knowledgeBase",
    "knowledgeConnector",
    "knowledgeFile",
    "llmVirtualKey",
    "llmProviderApiKey",
    "environment",
    "serviceAccount",
    "scheduledTask",
  ].flatMap((resource) =>
    (["read", "use", "update", "delete", "manage-permissions"] as const).map(
      (action) => ({ resource, scope: "*", action }),
    ),
  ) as archestraApiTypes.GetScopedCapabilitiesResponses["200"];

// Better-Auth's `/api/auth/organization/get-full-organization` response;
// shape derived from the fields the Better-Auth client reads after parsing.
type BetterAuthFullOrg = {
  id: string;
  name: string;
  slug: string;
  logo: string | null;
  createdAt: string;
  metadata: string | null;
  members: unknown[];
  invitations: unknown[];
  teams: unknown[];
};

export function makeBetterAuthOrg(
  overrides: Partial<BetterAuthFullOrg> = {},
): BetterAuthFullOrg {
  return {
    id: "test-org",
    name: "Test Org",
    slug: "test-org",
    logo: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    metadata: null,
    members: [],
    invitations: [],
    teams: [],
    ...overrides,
  };
}

export const betterAuthOrgSeed = makeBetterAuthOrg();
