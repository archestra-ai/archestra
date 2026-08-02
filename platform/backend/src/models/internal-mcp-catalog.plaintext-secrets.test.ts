import { eq } from "drizzle-orm";
import db, { schema } from "@/database";
import InternalMcpCatalogModel from "@/models/internal-mcp-catalog";
import InternalMcpCatalogVersionModel from "@/models/internal-mcp-catalog-version";
import { describe, expect, test } from "@/test";
import type { OAuthConfig } from "@/types";

// The write boundary (create/update) must strip `expandSecrets`-materialized
// plaintext before it reaches the row — the sanctioned path stores secret
// values in bundles, so anything else is a leaked expanded read written back
// (e.g. the serviceAccount write-back spreading an expanded localConfig).

async function readRow(id: string) {
  const [row] = await db
    .select()
    .from(schema.internalMcpCatalogTable)
    .where(eq(schema.internalMcpCatalogTable.id, id));
  return row;
}

const oauthConfigWith = (clientSecret: string): OAuthConfig => ({
  name: "provider",
  server_url: "https://provider.example.com",
  client_id: "client-id",
  client_secret: clientSecret,
  redirect_uris: ["https://app.example.com/callback"],
  scopes: ["read"],
  default_scopes: ["read"],
  supports_resource_metadata: false,
});

describe("catalog write boundary strips managed plaintext secrets", () => {
  test("create(): bundle-backed localConfig plaintext never reaches the row; bundle-less inline oauth secret survives", async ({
    makeInternalMcpCatalog,
    makeSecret,
  }) => {
    const secret = await makeSecret({ secret: { TOKEN: "real-token" } });
    const catalog = await makeInternalMcpCatalog({
      serverType: "local",
      serverUrl: null,
      localConfigSecretId: secret.id,
      localConfig: {
        dockerImage: "example/image:1",
        environment: [
          {
            key: "TOKEN",
            type: "secret",
            promptOnInstallation: false,
            value: "leaked-token",
          },
        ],
        imagePullSecrets: [
          {
            source: "credentials",
            server: "registry.example.com",
            username: "bot",
            password: "leaked-password",
          },
        ],
      },
      // No clientSecretId in play: a legacy-shaped inline client secret is
      // the row's only copy and must be preserved.
      oauthConfig: oauthConfigWith("legacy-inline-secret"),
    });

    const row = await readRow(catalog.id);
    expect(row?.localConfig?.environment?.[0]).not.toHaveProperty("value");
    expect(row?.localConfig?.imagePullSecrets?.[0]).not.toHaveProperty(
      "password",
    );
    expect(row?.oauthConfig?.client_secret).toBe("legacy-inline-secret");
  });

  test("update(): payload bundle ids win — oauth and enterprise plaintext are stripped", async ({
    makeInternalMcpCatalog,
    makeSecret,
  }) => {
    const catalog = await makeInternalMcpCatalog();
    const secret = await makeSecret({
      secret: { client_secret: "real-client-secret" },
    });

    const updated = await InternalMcpCatalogModel.update(catalog.id, {
      clientSecretId: secret.id,
      oauthConfig: oauthConfigWith("leaked-client-secret"),
      enterpriseManagedConfig: { clientSecretOverride: "leaked-override" },
    });

    expect(updated?.clientSecretId).toBe(secret.id);
    const row = await readRow(catalog.id);
    expect(row?.oauthConfig).not.toHaveProperty("client_secret");
    expect(row?.enterpriseManagedConfig).not.toHaveProperty(
      "clientSecretOverride",
    );
  });

  test("update(): falls back to the existing row's bundle ids when the payload carries none", async ({
    makeInternalMcpCatalog,
    makeSecret,
  }) => {
    const secret = await makeSecret({ secret: { TOKEN: "real-token" } });
    const catalog = await makeInternalMcpCatalog({
      serverType: "local",
      serverUrl: null,
      localConfigSecretId: secret.id,
      localConfig: {
        environment: [
          {
            key: "TOKEN",
            type: "secret",
            promptOnInstallation: false,
            required: true,
          },
        ],
      },
    });

    await InternalMcpCatalogModel.update(catalog.id, {
      localConfig: {
        environment: [
          {
            key: "TOKEN",
            type: "secret",
            promptOnInstallation: false,
            required: true,
            value: "leaked-token",
          },
        ],
      },
    });

    const row = await readRow(catalog.id);
    expect(row?.localConfig?.environment?.[0]).not.toHaveProperty("value");
  });

  test("update(): preserves inline client_secret on a bundle-less legacy row (OAuth fallback)", async ({
    makeInternalMcpCatalog,
  }) => {
    const catalog = await makeInternalMcpCatalog();

    await InternalMcpCatalogModel.update(catalog.id, {
      oauthConfig: oauthConfigWith("legacy-inline-secret"),
    });

    const row = await readRow(catalog.id);
    expect(row?.clientSecretId).toBeNull();
    expect(row?.oauthConfig?.client_secret).toBe("legacy-inline-secret");
  });

  test("update() never mutates the caller's payload (deployment flows reuse it)", async ({
    makeInternalMcpCatalog,
    makeSecret,
  }) => {
    const secret = await makeSecret({ secret: { TOKEN: "real-token" } });
    const catalog = await makeInternalMcpCatalog({
      serverType: "local",
      serverUrl: null,
      localConfigSecretId: secret.id,
    });

    const payload = {
      localConfig: {
        environment: [
          {
            key: "TOKEN",
            type: "secret" as const,
            promptOnInstallation: false,
            value: "leaked-token",
          },
        ],
      },
    };
    await InternalMcpCatalogModel.update(catalog.id, payload);

    expect(payload.localConfig.environment[0].value).toBe("leaked-token");
    const row = await readRow(catalog.id);
    expect(row?.localConfig?.environment?.[0]).not.toHaveProperty("value");
  });

  test("end-to-end: an expanded read written back leaves the row and version history clean", async ({
    makeInternalMcpCatalog,
    makeSecret,
  }) => {
    const secretValue = `real-secret-${crypto.randomUUID()}`;
    const secret = await makeSecret({ secret: { TOKEN: secretValue } });
    const catalog = await makeInternalMcpCatalog({
      serverType: "local",
      serverUrl: null,
      localConfigSecretId: secret.id,
      localConfig: {
        dockerImage: "example/image:1",
        environment: [
          {
            key: "TOKEN",
            type: "secret",
            promptOnInstallation: false,
            required: true,
          },
        ],
      },
    });

    // The exact shape of the serviceAccount write-back in routes/mcp-server.ts:
    // a default (expanded) read, spread into an update payload.
    const expanded = await InternalMcpCatalogModel.findById(catalog.id);
    expect(expanded?.localConfig?.environment?.[0]?.value).toBe(secretValue);

    await InternalMcpCatalogModel.update(catalog.id, {
      localConfig: {
        ...expanded?.localConfig,
        serviceAccount: "custom-sa",
      },
    });

    const row = await readRow(catalog.id);
    expect(row?.localConfig?.serviceAccount).toBe("custom-sa");
    expect(row?.localConfig?.environment?.[0]).not.toHaveProperty("value");
    expect(JSON.stringify(row?.localConfig)).not.toContain(secretValue);

    // The forked snapshot of that write is clean too, and the caller's
    // expanded object still holds the value for its own deployment work.
    const head = await InternalMcpCatalogVersionModel.findByCatalogAndVersion({
      catalogId: catalog.id,
      version: 2,
    });
    expect(head).not.toBeNull();
    expect(
      (head?.snapshot.localConfig as { serviceAccount?: string })
        .serviceAccount,
    ).toBe("custom-sa");
    expect(JSON.stringify(head?.snapshot)).not.toContain(secretValue);
    expect(expanded?.localConfig?.environment?.[0]?.value).toBe(secretValue);
  });
});
