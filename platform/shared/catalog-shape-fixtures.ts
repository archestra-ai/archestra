/**
 * Canonical catalog shape fixtures.
 *
 * One representative per production shape that bugs have hidden in (or
 * could hide in). Add a new shape only when production exposes a
 * dimension the existing fixtures don't cover.
 *
 * Each fixture's `id` describes the shape's diagnostic features so a
 * reviewer can tell at a glance what test surface it exercises:
 *
 *   envprobeCleanLocal     — local stdio, command + arguments populated
 *   hdrprobeDockerOnly     — local docker-image-only, NO command/arguments
 *                            (regression target: transformFormToApiData
 *                            used to add empty defaults that tripped
 *                            isMetadataOnlyEdit's localConfig diff)
 *   sqlOneBagLocal         — local with populated localConfigSecretId
 *                            (regression target: expanded-vs-raw
 *                            backend asymmetry that used to force the
 *                            bar on description-only edits) plus
 *                            header-userConfig that produces a non-empty
 *                            additionalHeaders[] in the form
 *                            (regression target: dirtyFields-as-array-
 *                            of-falses being truthy)
 *   test1RemoteOAuthBag    — remote OAuth with a populated client secret bag
 *   multitenantLocalShared — local + multitenant=true (shared deployment
 *                            copy variant for the confirm bar)
 *   promptedEnvLocal       — local with prompted env vars
 *                            (regression target: schema-evolution rules
 *                            for promptedEnvVarsChanged)
 *
 * The structural type is intentionally narrower than the full API
 * `GetInternalMcpCatalogResponses["200"][number]` — the fixtures only
 * need the fields the cascade predicates inspect, plus enough identity
 * fields to round-trip through DB-shape assertions.
 */

export type CatalogShapeFixture = {
  id: string;
  name: string;
  description: string;
  serverType: "local" | "remote" | "builtin";
  multitenant: boolean;
  serverUrl?: string | null;
  clientSecretId: string | null;
  localConfigSecretId: string | null;
  localConfig: {
    command?: string;
    arguments?: string[];
    environment?: Array<{
      key: string;
      type: "plain_text" | "secret" | "boolean" | "number";
      value?: string;
      promptOnInstallation: boolean;
      required?: boolean;
      sensitive?: boolean;
      description?: string;
      // Flips pod-spec layout between env var (false) and a mounted
      // secret file at `/secrets/<key>` (true). Tracked by the cascade
      // gate's `promptedEnvVarsRuntimeChanged`.
      mounted?: boolean;
    }>;
    envFrom?: Array<{ type: "secret" | "configMap"; name: string }>;
    dockerImage?: string;
    transportType?: "stdio" | "streamable-http";
    httpPort?: number;
    httpPath?: string;
    imagePullSecrets?: Array<Record<string, unknown>>;
  } | null;
  userConfig: Record<string, unknown> | null;
  oauthConfig: Record<string, unknown> | null;
  enterpriseManagedConfig: Record<string, unknown> | null;
  icon: string | null;
  organizationId: string | null;
  authorId: string | null;
  scope: "personal" | "team" | "org";
  labels?: Array<{ key: string; value: string }>;
  teams?: Array<{ id: string; name: string; level: "use" | "write" }>;
};

/**
 * The shape registry. Keyed by stable id; tests reference shapes by
 * this id via `scenario.shape: keyof typeof CATALOG_SHAPES` for compile-
 * time enforcement that scenarios point at real fixtures.
 */
export const CATALOG_SHAPES = {
  envprobeCleanLocal: {
    id: "fixture-envprobe-clean-local",
    name: "envprobe-clean-local",
    description: "local stdio with command + arguments",
    serverType: "local",
    multitenant: false,
    serverUrl: null,
    clientSecretId: null,
    localConfigSecretId: null,
    localConfig: {
      command: "sh",
      arguments: ["-c", "echo hi"],
      environment: [],
      transportType: "stdio",
    },
    userConfig: {},
    oauthConfig: null,
    enterpriseManagedConfig: null,
    icon: null,
    organizationId: "org-1",
    authorId: "user-1",
    scope: "personal",
    labels: [],
  },

  teamScopedLocal: {
    id: "fixture-team-scoped-local",
    name: "team-scoped-local",
    description: "local stdio shared with two teams at different access levels",
    serverType: "local",
    multitenant: false,
    serverUrl: null,
    clientSecretId: null,
    localConfigSecretId: null,
    localConfig: {
      command: "sh",
      arguments: ["-c", "echo hi"],
      environment: [],
      transportType: "stdio",
    },
    userConfig: {},
    oauthConfig: null,
    enterpriseManagedConfig: null,
    icon: null,
    organizationId: "org-1",
    authorId: "user-1",
    scope: "team",
    labels: [],
    teams: [
      { id: "team-platform", name: "platform", level: "write" },
      { id: "team-data", name: "data", level: "use" },
    ],
  },

  hdrprobeDockerOnly: {
    id: "fixture-hdrprobe-docker-only",
    name: "hdrprobe-docker-only",
    description:
      "local docker-image-only streamable-http; NO command/arguments",
    serverType: "local",
    multitenant: false,
    serverUrl: null,
    clientSecretId: null,
    localConfigSecretId: null,
    // Note absence of `command` and `arguments` — this is the shape
    // that tripped the form's `transformFormToApiData` round-trip.
    localConfig: {
      environment: [],
      envFrom: [],
      dockerImage: "mendhak/http-https-echo:30",
      transportType: "streamable-http",
      httpPort: 8080,
      httpPath: "/mcp",
      imagePullSecrets: [],
    },
    userConfig: {
      header_x_static_token: {
        type: "string",
        title: "x-static-token",
        description: "Sent as x-static-token",
        promptOnInstallation: false,
        required: false,
        sensitive: false,
        headerName: "x-static-token",
        // The form writes static header values into `default`. Having
        // one in the baseline lets the `change-static-header-value`
        // scenario exercise the "default rotated" path.
        default: "initial-token-value",
      },
    },
    oauthConfig: null,
    enterpriseManagedConfig: null,
    icon: null,
    organizationId: "org-1",
    authorId: "user-1",
    scope: "personal",
    labels: [],
  },

  sqlOneBagLocal: {
    id: "fixture-sql-one-bag-local",
    name: "sql-one-bag-local",
    description: "local docker with secret bag + header userConfig",
    serverType: "local",
    multitenant: false,
    serverUrl: null,
    clientSecretId: null,
    // Populated bag — backend used to expand secret values into
    // `localConfig.environment[*].value` and break the metadata-only
    // comparison.
    localConfigSecretId: "bag-secret-id-sql1",
    localConfig: {
      environment: [
        {
          key: "DB_PASSWORD",
          type: "secret",
          value: "",
          promptOnInstallation: false,
          required: false,
        },
        {
          key: "STATIC_FLAG",
          type: "plain_text",
          value: "yes",
          promptOnInstallation: false,
          required: false,
        },
      ],
      dockerImage: "mendhak/http-https-echo:30",
      transportType: "streamable-http",
      httpPort: 8080,
      httpPath: "/mcp",
    },
    // A userConfig with a header-mapped field — the frontend derives a
    // non-empty `additionalHeaders[]` from this, which produces the
    // RHF `dirtyFields.additionalHeaders = [{...all false}]` trap.
    userConfig: {
      header_x_db_url: {
        type: "string",
        title: "x-db-url",
        description: "Sent as x-db-url",
        promptOnInstallation: false,
        required: false,
        sensitive: false,
        headerName: "x-db-url",
      },
      // A required, prompt-on-install header used by `demote-header-to-optional`
      // to exercise the required→optional transition. Distinct field key so
      // existing scenarios targeting `header_x_db_url` are unaffected.
      header_x_required_token: {
        type: "string",
        title: "x-required-token",
        description: "Sent as x-required-token",
        promptOnInstallation: true,
        required: true,
        sensitive: false,
        headerName: "x-required-token",
      },
    },
    oauthConfig: null,
    enterpriseManagedConfig: null,
    icon: null,
    organizationId: "org-1",
    authorId: "user-1",
    scope: "personal",
    labels: [],
  },

  test1RemoteOAuthBag: {
    id: "fixture-test1-remote-oauth-bag",
    name: "test1-remote-oauth-bag",
    description: "remote OAuth catalog with populated client secret bag",
    serverType: "remote",
    multitenant: false,
    serverUrl: "https://example.test/mcp",
    clientSecretId: "client-secret-id-test1",
    localConfigSecretId: null,
    localConfig: null,
    userConfig: {
      header_x_e: {
        type: "string",
        title: "x-e",
        description: "Sent as x-e",
        promptOnInstallation: false,
        required: false,
        sensitive: false,
        headerName: "x-e",
      },
    },
    oauthConfig: {
      name: "test1",
      server_url: "https://example.test/oauth",
      client_id: "client-1",
      client_secret: "",
      redirect_uris: ["https://example.test/cb"],
      scopes: ["read"],
      default_scopes: ["read"],
      supports_resource_metadata: false,
    },
    enterpriseManagedConfig: null,
    icon: null,
    organizationId: "org-1",
    authorId: "user-1",
    scope: "org",
    labels: [],
  },

  multitenantLocalShared: {
    id: "fixture-multitenant-local-shared",
    name: "multitenant-local-shared",
    description: "local + multitenant=true (single shared deployment)",
    serverType: "local",
    multitenant: true,
    serverUrl: null,
    clientSecretId: null,
    localConfigSecretId: null,
    localConfig: {
      command: "node",
      arguments: ["server.js"],
      environment: [],
      transportType: "stdio",
    },
    userConfig: {},
    oauthConfig: null,
    enterpriseManagedConfig: null,
    icon: null,
    organizationId: "org-1",
    authorId: "user-1",
    scope: "org",
    labels: [],
  },

  promptedEnvLocal: {
    id: "fixture-prompted-env-local",
    name: "prompted-env-local",
    description: "local with mixed prompted/static env vars",
    serverType: "local",
    multitenant: false,
    serverUrl: null,
    clientSecretId: null,
    localConfigSecretId: null,
    localConfig: {
      command: "node",
      arguments: ["server.js"],
      environment: [
        {
          key: "EXISTING_OPTIONAL_PROMPT",
          type: "plain_text",
          promptOnInstallation: true,
          required: false,
        },
        {
          key: "EXISTING_REQUIRED_PROMPT",
          type: "secret",
          promptOnInstallation: true,
          required: true,
        },
        {
          key: "STATIC_VAR",
          type: "plain_text",
          value: "static-value",
          promptOnInstallation: false,
          required: false,
        },
      ],
      transportType: "stdio",
    },
    userConfig: {},
    oauthConfig: null,
    enterpriseManagedConfig: null,
    icon: null,
    organizationId: "org-1",
    authorId: "user-1",
    scope: "personal",
    labels: [],
  },
} as const satisfies Record<string, CatalogShapeFixture>;

export type CatalogShapeId = keyof typeof CATALOG_SHAPES;
