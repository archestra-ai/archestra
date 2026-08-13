import { afterEach, describe, expect, test, vi } from "vitest";
import type {
  ConnectorCredentials,
  PermissionSyncParams,
  PermissionSyncState,
} from "@/types";
import { MFilesConnector } from "./mfiles-connector";

const VAULT_GUID = "{C840BE1A-5B47-4AC0-8EF7-835C166C8E24}";
const ADD_ON_INSTANCE_ID = "9435379d-0c21-4426-97bf-205356f96422";
const CONFIG = {
  type: "mfiles",
  baseUrl: "https://mfiles.example.com/m-files",
  vaultGuid: VAULT_GUID,
  authMethod: "mfiles_password_token",
  objectTypeIds: [0],
  batchSize: 10,
  permissionExtensionMethod: "ArchestraKnowledgePermissionSnapshot",
} as const;
const CREDENTIALS: ConnectorCredentials = {
  email: "svc-knowledge",
  apiToken: "secret",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("MFilesConnector.validateConfig", () => {
  test("validates both production authentication modes", async () => {
    const connector = new MFilesConnector();
    await expect(connector.validateConfig(CONFIG)).resolves.toEqual({
      valid: true,
    });
    await expect(
      connector.validateConfig({
        ...CONFIG,
        authMethod: "oauth_client_credentials",
        oauthTokenEndpoint: "https://login.example.com/oauth2/token",
        oauthAuthConfig: "application-account",
        oauthAuthConfigScope: "technical",
        oauthAccountName: String.raw`integration\archestra`,
        oauthScope: "mfiles/.default",
      }),
    ).resolves.toEqual({ valid: true });
  });

  test("rejects ambiguous OAuth and source configuration", async () => {
    const connector = new MFilesConnector();
    await expect(
      connector.validateConfig({ ...CONFIG, objectTypeIds: [0, 0] }),
    ).resolves.toEqual({
      valid: false,
      error: "objectTypeIds must not contain duplicates",
    });
    await expect(
      connector.validateConfig({
        ...CONFIG,
        authMethod: "oauth_client_credentials",
        oauthTokenEndpoint: "https://login.example.com/oauth2/token",
        oauthAuthConfig: "application-account",
        oauthAuthConfigScope: "technical",
        oauthAccountName: String.raw`integration\archestra`,
        oauthScope: "mfiles/.default",
        oauthResource: "mfiles",
      }),
    ).resolves.toEqual({
      valid: false,
      error: "Configure oauthScope or oauthResource, not both",
    });
  });
});

describe("MFilesConnector authentication", () => {
  test("derives an expiring MFWS token, preserves stickiness, and preflights add-on schema v2", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          { Value: "authentication-token" },
          { "set-cookie": "mfilesmsm=server-a; Path=/; Secure; HttpOnly" },
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ UserID: 42 }))
      .mockResolvedValueOnce(extensionResponse(capabilities()));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new MFilesConnector().testConnection({
        config: CONFIG,
        credentials: CREDENTIALS,
      }),
    ).resolves.toEqual({ success: true });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body).toMatchObject({
      Username: "svc-knowledge",
      Password: "secret",
      VaultGuid: VAULT_GUID,
    });
    expect(body.SessionID).toMatch(/^[0-9a-f-]{36}$/);
    expect(Date.parse(body.Expiration)).toBeGreaterThan(Date.now());
    const sessionHeaders = new Headers(fetchMock.mock.calls[1][1]?.headers);
    expect(sessionHeaders.get("X-Authentication")).toBe("authentication-token");
    expect(sessionHeaders.get("Cookie")).toBe("mfilesmsm=server-a");
    expect(extensionBody(fetchMock, 2)).toEqual({
      schemaVersion: 2,
      operation: "getCapabilities",
    });
  });

  test("uses OAuth Application Account client credentials and MFWS headers", async () => {
    const oauthConfig = {
      ...CONFIG,
      authMethod: "oauth_client_credentials",
      oauthTokenEndpoint: "https://login.example.com/oauth2/token",
      oauthAuthConfig: "mfiles-application-account",
      oauthAuthConfigScope: "technical",
      oauthAccountName: String.raw`integration\archestra`,
      oauthScope: "https://mfiles.example.com/.default",
      oauthClientAuthMethod: "client_secret_basic",
    } as const;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ access_token: "oauth-token", expires_in: 3600 }),
      )
      .mockResolvedValueOnce(jsonResponse({ UserID: 42 }))
      .mockResolvedValueOnce(extensionResponse(capabilities()));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new MFilesConnector().testConnection({
        config: oauthConfig,
        credentials: { email: "client-id", apiToken: "client-secret" },
      }),
    ).resolves.toEqual({ success: true });

    expect(fetchMock.mock.calls[0][0]).toBe(oauthConfig.oauthTokenEndpoint);
    const tokenHeaders = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(tokenHeaders.get("Authorization")).toBe(
      `Basic ${Buffer.from("client-id:client-secret").toString("base64")}`,
    );
    expect(String(fetchMock.mock.calls[0][1]?.body)).toContain(
      "grant_type=client_credentials",
    );
    const mfwsHeaders = new Headers(fetchMock.mock.calls[1][1]?.headers);
    expect(mfwsHeaders.get("Authorization")).toBe("Bearer oauth-token");
    expect(mfwsHeaders.get("X-Vault")).toBe(VAULT_GUID);
    expect(mfwsHeaders.get("X-AuthConfig")).toBe("mfiles-application-account");
    expect(mfwsHeaders.get("X-AuthConfigScope")).toBe("technical:");
    expect(mfwsHeaders.get("X-ExtraAuthData")).toBe(
      String.raw`AuthType=Client;UpdateMetadata=true;AccountName=integration\archestra`,
    );
  });

  test("falls back to HTTP Basic when the provider rejects the secret in the request body", async () => {
    // No oauthClientAuthMethod configured: the connector negotiates instead
    // of making admins know their provider's registered client method.
    const oauthConfig = {
      ...CONFIG,
      authMethod: "oauth_client_credentials",
      oauthTokenEndpoint: "https://login.example.com/oauth2/token",
      oauthAuthConfig: "mfiles-application-account",
      oauthAuthConfigScope: "technical:",
      oauthAccountName: String.raw`integration\archestra`,
    } as const;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "invalid_client" }), {
          status: 401,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ access_token: "oauth-token", expires_in: 3600 }),
      )
      .mockResolvedValueOnce(jsonResponse({ UserID: 42 }))
      .mockResolvedValueOnce(extensionResponse(capabilities()));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new MFilesConnector().testConnection({
        config: oauthConfig,
        credentials: { email: "client-id", apiToken: "client-secret" },
      }),
    ).resolves.toEqual({ success: true });

    // First attempt: secret in the form body, no Authorization header.
    const firstHeaders = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(firstHeaders.get("Authorization")).toBeNull();
    expect(String(fetchMock.mock.calls[0][1]?.body)).toContain(
      "client_secret=client-secret",
    );
    // Fallback: HTTP Basic, secret no longer in the body.
    const secondHeaders = new Headers(fetchMock.mock.calls[1][1]?.headers);
    expect(secondHeaders.get("Authorization")).toBe(
      `Basic ${Buffer.from("client-id:client-secret").toString("base64")}`,
    );
    expect(String(fetchMock.mock.calls[1][1]?.body)).not.toContain(
      "client_secret=",
    );
  });

  test("retries the token audience as resource for providers that reject scope", async () => {
    // A single audience value is configured as scope; AD FS-style providers
    // reject the scope parameter with a 400 and expect the same value as
    // resource. The connector negotiates instead of asking the admin which
    // parameter name their provider uses.
    const oauthConfig = {
      ...CONFIG,
      authMethod: "oauth_client_credentials",
      oauthTokenEndpoint: "https://login.example.com/oauth2/token",
      oauthAuthConfig: "mfiles-application-account",
      oauthAuthConfigScope: "technical",
      oauthAccountName: String.raw`integration\archestra`,
      oauthScope: "https://mfiles.example.com",
    } as const;
    const rejectScope = () =>
      new Response(JSON.stringify({ error: "invalid_scope" }), { status: 400 });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(rejectScope())
      .mockResolvedValueOnce(rejectScope())
      .mockResolvedValueOnce(
        jsonResponse({ access_token: "oauth-token", expires_in: 3600 }),
      )
      .mockResolvedValueOnce(jsonResponse({ UserID: 42 }))
      .mockResolvedValueOnce(extensionResponse(capabilities()));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new MFilesConnector().testConnection({
        config: oauthConfig,
        credentials: { email: "client-id", apiToken: "client-secret" },
      }),
    ).resolves.toEqual({ success: true });

    // Attempts 1-2 carry the value as scope (both client auth methods)...
    expect(String(fetchMock.mock.calls[0][1]?.body)).toContain("scope=");
    expect(String(fetchMock.mock.calls[1][1]?.body)).toContain("scope=");
    // ...attempt 3 retries it as resource.
    const retryBody = String(fetchMock.mock.calls[2][1]?.body);
    expect(retryBody).toContain(
      `resource=${encodeURIComponent("https://mfiles.example.com")}`,
    );
    expect(retryBody).not.toContain("scope=");
  });

  test("reacquires once after a 403 from a different multi-server node", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse("token-a"))
      .mockResolvedValueOnce(new Response("forbidden", { status: 403 }))
      .mockResolvedValueOnce(jsonResponse("token-b"))
      .mockResolvedValueOnce(jsonResponse({ UserID: 42 }))
      .mockResolvedValueOnce(extensionResponse(capabilities()));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new MFilesConnector().testConnection({
        config: CONFIG,
        credentials: CREDENTIALS,
      }),
    ).resolves.toEqual({ success: true });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});

describe("MFilesConnector content sync", () => {
  test("runs a completion-gated baseline and commits the captured journal head", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse("token"))
      .mockResolvedValueOnce(extensionResponse(capabilities("12")))
      .mockResolvedValueOnce(
        extensionResponse(objectPage([{ objectTypeId: 0, objectId: 123 }])),
      )
      .mockResolvedValueOnce(jsonResponse(objectVersion()))
      .mockResolvedValueOnce(new Response("# Safe handbook", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const batches = await collect(
      new MFilesConnector().sync({
        config: CONFIG,
        credentials: CREDENTIALS,
        checkpoint: null,
      }),
    );

    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatchObject({
      hasMore: false,
      checkpoint: {
        type: "mfiles",
        changeCursor: "12",
        addOnInstanceId: ADD_ON_INSTANCE_ID,
      },
      completionSweep: {
        metadataKey: "mfilesBaselineGeneration",
      },
    });
    const generation = batches[0].completionSweep?.generation;
    expect(generation).toMatch(/^[0-9a-f-]{36}$/);
    expect(batches[0].documents).toEqual([
      expect.objectContaining({
        id: "mfiles:0:123:file:8",
        title: "Engineering handbook",
        content: "# Safe handbook",
        sourceUrl: "https://mfiles.example.com/m-files/REST/objects/0/123/7",
        metadata: expect.objectContaining({
          mfilesObjectKey: "0:123",
          objectVersion: 7,
          mfilesBaselineGeneration: generation,
        }),
      }),
    ]);
    expect(extensionBody(fetchMock, 2)).toEqual({
      schemaVersion: 2,
      operation: "enumerateObjects",
      cursor: null,
      limit: 10,
      objectTypeIds: [0],
    });
  });

  test("commits and sweeps an empty authoritative baseline", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse("token"))
      .mockResolvedValueOnce(extensionResponse(capabilities("4")))
      .mockResolvedValueOnce(extensionResponse(objectPage([])));
    vi.stubGlobal("fetch", fetchMock);

    const [batch] = await collect(
      new MFilesConnector().sync({
        config: CONFIG,
        credentials: CREDENTIALS,
        checkpoint: null,
      }),
    );

    expect(batch.documents).toEqual([]);
    expect(batch.hasMore).toBe(false);
    expect(batch.checkpoint).toMatchObject({ changeCursor: "4" });
    expect(batch.completionSweep).toBeDefined();
  });

  test("a clean journal pass is delta-only and performs no object reads", async () => {
    const baseline = await runOneObjectBaseline();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse("token"))
      .mockResolvedValueOnce(extensionResponse(capabilities("12")))
      .mockResolvedValueOnce(
        extensionResponse(changePage({ cursor: "12", pinned: "12" })),
      );
    vi.stubGlobal("fetch", fetchMock);

    const [batch] = await collect(
      new MFilesConnector().sync({
        config: CONFIG,
        credentials: { ...CREDENTIALS, apiToken: "rotated-secret" },
        checkpoint: baseline.checkpoint,
      }),
    );

    expect(batch).toMatchObject({ documents: [], hasMore: false });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      Username: CREDENTIALS.email,
      Password: "rotated-secret",
    });
    expect(fetchMock.mock.calls.map(([url]) => String(url))).not.toEqual(
      expect.arrayContaining([expect.stringContaining("/objects/")]),
    );
    expect(extensionBody(fetchMock, 2)).toMatchObject({
      operation: "readChanges",
      cursor: "12",
      pinnedHeadCursor: null,
    });
  });

  test("starts an authoritative baseline when the login identity changes", async () => {
    const baseline = await runOneObjectBaseline();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse("token"))
      .mockResolvedValueOnce(extensionResponse(capabilities("12")))
      .mockResolvedValueOnce(extensionResponse(objectPage([])));
    vi.stubGlobal("fetch", fetchMock);

    const [batch] = await collect(
      new MFilesConnector().sync({
        config: CONFIG,
        credentials: { ...CREDENTIALS, email: "svc-knowledge-replacement" },
        checkpoint: baseline.checkpoint,
      }),
    );

    expect(batch).toMatchObject({
      documents: [],
      hasMore: false,
      completionSweep: { metadataKey: "mfilesBaselineGeneration" },
    });
    expect(extensionBody(fetchMock, 2)).toMatchObject({
      operation: "enumerateObjects",
      cursor: null,
    });
  });

  test("reconciles changed files and deleted objects from a pinned delta", async () => {
    const baseline = await runOneObjectBaseline();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse("token"))
      .mockResolvedValueOnce(extensionResponse(capabilities("14")))
      .mockResolvedValueOnce(
        extensionResponse(
          changePage({
            cursor: "14",
            pinned: "14",
            changes: [
              change("13", "object-upsert", 123),
              change("14", "object-delete", 999),
            ],
          }),
        ),
      )
      .mockResolvedValueOnce(jsonResponse(objectVersion({ version: 8 })))
      .mockResolvedValueOnce(new Response("updated", { status: 200 }))
      .mockResolvedValueOnce(new Response("missing", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    const batches = await collect(
      new MFilesConnector().sync({
        config: CONFIG,
        credentials: CREDENTIALS,
        checkpoint: baseline.checkpoint,
      }),
    );

    expect(batches.flatMap((batch) => batch.documents)).toEqual([
      expect.objectContaining({
        id: "mfiles:0:123:file:8",
        content: "updated",
      }),
    ]);
    expect(batches.flatMap((batch) => batch.reconcileScopes ?? [])).toEqual([
      {
        metadataFilter: { mfilesObjectKey: "0:123" },
        seenSourceIds: ["mfiles:0:123:file:8"],
      },
      {
        metadataFilter: { mfilesObjectKey: "0:999" },
        seenSourceIds: [],
      },
    ]);
    expect(batches.at(-1)?.checkpoint).toMatchObject({ changeCursor: "14" });
  });

  test("falls back to an authoritative baseline when the journal reports a gap", async () => {
    const baseline = await runOneObjectBaseline();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse("token"))
      .mockResolvedValueOnce(extensionResponse(capabilities("30")))
      .mockResolvedValueOnce(
        extensionResponse(
          changePage({
            cursor: "30",
            pinned: "30",
            fullRequired: true,
          }),
        ),
      )
      .mockResolvedValueOnce(extensionResponse(objectPage([])));
    vi.stubGlobal("fetch", fetchMock);

    const [batch] = await collect(
      new MFilesConnector().sync({
        config: CONFIG,
        credentials: CREDENTIALS,
        checkpoint: baseline.checkpoint,
      }),
    );

    expect(batch.completionSweep).toBeDefined();
    expect(batch.checkpoint).toMatchObject({ changeCursor: "30" });
    expect(extensionBody(fetchMock, 3)).toMatchObject({
      operation: "enumerateObjects",
      cursor: null,
    });
  });
});

describe("MFilesConnector permission sync", () => {
  test("requests exact latest and cached-version ACLs and honors manual account mapping", async () => {
    const readIngestedDocuments = ingestedDocuments([
      {
        sourceId: "mfiles:0:123:file:8",
        metadata: { objectVersion: 6 },
      },
    ]);
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse("token"))
      .mockResolvedValueOnce(
        extensionResponse(objectPage([{ objectTypeId: 0, objectId: 123 }])),
      )
      .mockResolvedValueOnce(
        extensionResponse(
          permissionPage({
            users: [{ accountId: "42", email: null }],
            groups: ["7"],
          }),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const items = await collect(
      new MFilesConnector().syncPermissionSnapshot({
        config: CONFIG,
        credentials: CREDENTIALS,
        cursor: null,
        readIngestedDocuments,
        resolveMappedEmail: (accountId) =>
          accountId === "42" ? "Mapped@Example.com" : null,
      }),
    );

    expect(extensionBody(fetchMock, 2)).toEqual({
      schemaVersion: 2,
      operation: "getObjectPermissionsByKeys",
      objects: [
        {
          objectTypeId: 0,
          objectId: 123,
          cachedVersions: [6],
        },
      ],
    });
    expect(items).toEqual([
      expect.objectContaining({
        kind: "container",
        permissions: {
          users: ["mapped@example.com"],
          groups: ["7"],
          isPublic: false,
        },
        audienceResolutionFailed: false,
      }),
      expect.objectContaining({
        kind: "document",
        sourceId: "mfiles:0:123:file:8",
      }),
    ]);
  });

  test("drops unresolved principals but keeps the resolvable audience (under-grant)", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse("token"))
      .mockResolvedValueOnce(
        extensionResponse(objectPage([{ objectTypeId: 0, objectId: 123 }])),
      )
      .mockResolvedValueOnce(
        extensionResponse(
          permissionPage({
            users: [
              { accountId: "42", email: null },
              { accountId: "43", email: "Keep@Example.com" },
            ],
            groups: ["7"],
          }),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const [container] = await collect(
      new MFilesConnector().syncPermissionSnapshot({
        config: CONFIG,
        credentials: CREDENTIALS,
        cursor: null,
        readIngestedDocuments: ingestedDocuments([]),
      }),
    );

    // Account 42 has no email and no manual mapping, so it is dropped; account
    // 43 still grants access. Dropping a principal only narrows the audience.
    expect(container).toMatchObject({
      kind: "container",
      permissions: {
        users: ["keep@example.com"],
        groups: ["7"],
        isPublic: false,
      },
      audienceResolutionFailed: false,
    });
  });

  test("fails the entire audience closed only when the add-on cannot read the ACL", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse("token"))
      .mockResolvedValueOnce(
        extensionResponse(objectPage([{ objectTypeId: 0, objectId: 123 }])),
      )
      .mockResolvedValueOnce(
        extensionResponse(
          permissionPage({
            users: [{ accountId: "43", email: "keep@example.com" }],
            isPublic: true,
            audienceResolutionFailed: true,
          }),
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    const [container] = await collect(
      new MFilesConnector().syncPermissionSnapshot({
        config: CONFIG,
        credentials: CREDENTIALS,
        cursor: null,
        readIngestedDocuments: ingestedDocuments([]),
      }),
    );

    // The add-on flagged the ACL unreadable: fail the whole object closed even
    // though a principal resolved and the object looked public.
    expect(container).toMatchObject({
      kind: "container",
      permissions: { users: [], groups: [], isPublic: false },
      audienceResolutionFailed: true,
    });
  });

  test("a clean permission probe has no dirty ACL or group scope", async () => {
    const connector = new MFilesConnector();
    const firstFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse("token"))
      .mockResolvedValueOnce(extensionResponse(capabilities("20")));
    vi.stubGlobal("fetch", firstFetch);
    const initial = await connector.probePermissionChanges({
      config: CONFIG,
      credentials: CREDENTIALS,
      state: null,
    });
    expect(initial.fullRequired).toBe(true);

    const secondFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse("token"))
      .mockResolvedValueOnce(extensionResponse(capabilities("20")))
      .mockResolvedValueOnce(
        extensionResponse(changePage({ cursor: "20", pinned: "20" })),
      );
    vi.stubGlobal("fetch", secondFetch);
    const clean = await connector.probePermissionChanges({
      config: CONFIG,
      credentials: CREDENTIALS,
      state: initial.nextState as PermissionSyncState,
    });

    expect(clean).toMatchObject({
      dirtyContainerKeys: [],
      dirtyGroupIds: [],
      deletedGroupIds: [],
      fullRequired: false,
      authoritativeAudienceScope: true,
    });
    expect(clean.nextState).toMatchObject({ changeCursor: "20" });
  });

  test("returns exact object scope and promotes group changes to a safe full reconcile", async () => {
    const connector = new MFilesConnector();
    const initialFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse("token"))
      .mockResolvedValueOnce(extensionResponse(capabilities("20")));
    vi.stubGlobal("fetch", initialFetch);
    const initial = await connector.probePermissionChanges({
      config: CONFIG,
      credentials: CREDENTIALS,
      state: null,
    });
    const deltaFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse("token"))
      .mockResolvedValueOnce(extensionResponse(capabilities("23")))
      .mockResolvedValueOnce(
        extensionResponse(
          changePage({
            cursor: "23",
            pinned: "23",
            changes: [
              change("21", "object-permission", 123),
              change("22", "group-upsert", null, 7),
              change("23", "group-delete", null, 9),
            ],
          }),
        ),
      );
    vi.stubGlobal("fetch", deltaFetch);

    const delta = await connector.probePermissionChanges({
      config: CONFIG,
      credentials: CREDENTIALS,
      state: initial.nextState as PermissionSyncState,
    });

    expect(delta).toMatchObject({
      dirtyContainerKeys: ["object:0000000000:00000000000000000123"],
      dirtyGroupIds: ["7"],
      deletedGroupIds: ["9"],
      fullRequired: true,
    });
  });

  test("preserves group names and fail-closed membership status", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse("token"))
      .mockResolvedValueOnce(
        extensionResponse({
          schemaVersion: 2,
          groups: [
            {
              groupId: "7",
              name: "Engineering Readers",
              members: [],
              membershipResolutionFailed: true,
            },
          ],
          nextCursor: null,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const groups = await collect(
      new MFilesConnector().syncGroups({
        config: CONFIG,
        credentials: CREDENTIALS,
        cursor: null,
        readIngestedDocuments: ingestedDocuments([]),
      }),
    );

    expect(groups).toEqual([
      {
        groupId: "7",
        name: "Engineering Readers",
        members: [],
        membershipResolutionFailed: true,
      },
    ]);
  });
});

async function runOneObjectBaseline() {
  const fetchMock = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(jsonResponse("token"))
    .mockResolvedValueOnce(extensionResponse(capabilities("12")))
    .mockResolvedValueOnce(
      extensionResponse(objectPage([{ objectTypeId: 0, objectId: 123 }])),
    )
    .mockResolvedValueOnce(jsonResponse(objectVersion()))
    .mockResolvedValueOnce(new Response("baseline", { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  const batches = await collect(
    new MFilesConnector().sync({
      config: CONFIG,
      credentials: CREDENTIALS,
      checkpoint: null,
    }),
  );
  const batch = batches.at(-1);
  if (!batch) throw new Error("Expected an M-Files baseline batch");
  return batch;
}

function capabilities(headCursor = "8") {
  return {
    schemaVersion: 2,
    addOnVersion: "1.0.0",
    addOnInstanceId: ADD_ON_INSTANCE_ID,
    vaultGuid: VAULT_GUID,
    callerUserId: 42,
    journal: { headCursor, floorCursor: "1" },
    capabilities: {
      contentDelta: true,
      permissionDelta: true,
      groupDelta: true,
      managedObjectsOnly: true,
    },
    permissionPolicyFingerprint: "policy-v1",
  };
}

function objectPage(items: Array<{ objectTypeId: number; objectId: number }>) {
  return {
    schemaVersion: 2,
    items: items.map((item) => ({ ...item, latestVersion: 7 })),
    nextCursor: null,
  };
}

function changePage(params: {
  cursor: string;
  pinned: string;
  changes?: ReturnType<typeof change>[];
  fullRequired?: boolean;
}) {
  return {
    schemaVersion: 2,
    addOnInstanceId: ADD_ON_INSTANCE_ID,
    nextCursor: params.cursor,
    pinnedHeadCursor: params.pinned,
    hasMore: false,
    fullRequired: {
      content: params.fullRequired ?? false,
      permissions: params.fullRequired ?? false,
      groups: params.fullRequired ?? false,
      reasons: params.fullRequired ? ["journal-retention-gap"] : [],
    },
    changes: params.changes ?? [],
    permissionPolicyFingerprint: "policy-v1",
  };
}

function change(
  sequence: string,
  kind:
    | "object-upsert"
    | "object-permission"
    | "object-delete"
    | "group-upsert"
    | "group-delete",
  objectId: number | null,
  groupId?: number,
) {
  return {
    sequence,
    kind,
    objectTypeId: objectId === null ? null : 0,
    objectId,
    groupId: groupId ?? null,
  };
}

function objectVersion(params: { version?: number } = {}) {
  const version = params.version ?? 7;
  return {
    ObjVer: { Type: 0, ID: 123, Version: version },
    Title: "Engineering handbook",
    LastModifiedUtc: "2026-08-08T10:30:00.000Z",
    Files: [
      {
        ID: 8,
        Name: "handbook",
        Extension: "md",
        Version: version,
        ChangeTimeUtc: "2026-08-08T10:31:00.000Z",
      },
    ],
  };
}

function permissionPage(params: {
  users?: Array<{ accountId: string; email: string | null }>;
  groups?: string[];
  isPublic?: boolean;
  audienceResolutionFailed?: boolean;
}) {
  return {
    schemaVersion: 2,
    items: [
      {
        objectTypeId: 0,
        objectId: 123,
        latestVersion: 7,
        state: "active",
        users: params.users ?? [],
        groups: params.groups ?? [],
        isPublic: params.isPublic ?? false,
        fingerprint: "acl-v7",
        audienceResolutionFailed: params.audienceResolutionFailed ?? false,
      },
    ],
  };
}

function ingestedDocuments(
  documents: Awaited<
    ReturnType<PermissionSyncParams["readIngestedDocuments"]>
  >["documents"],
): PermissionSyncParams["readIngestedDocuments"] {
  return vi.fn().mockResolvedValue({ documents, nextAfterId: null });
}

function extensionBody(
  fetchMock: ReturnType<typeof vi.fn<typeof fetch>>,
  index: number,
) {
  return JSON.parse(String(fetchMock.mock.calls[index][1]?.body));
}

function jsonResponse(
  value: unknown,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function extensionResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "text/plain" },
  });
}

async function collect<T>(generator: AsyncGenerator<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of generator) values.push(value);
  return values;
}
