import { InternalMcpCatalogModel, SecretModel } from "@/models";
import { secretManager } from "@/secrets-manager";
import { describe, expect, test } from "@/test";

async function makeSourceWithAllSecrets(params: {
  organizationId: string;
  authorId: string;
  makeSecret: (overrides?: {
    name?: string;
    secret?: Record<string, unknown>;
  }) => Promise<{ id: string }>;
  name: string;
}) {
  const { organizationId, authorId, makeSecret, name } = params;
  const clientSecret = await makeSecret({
    name: `${name}-client`,
    secret: { client_secret: "source-client-secret" },
  });
  const localConfigSecret = await makeSecret({
    name: `${name}-local`,
    secret: { API_KEY: "source-api-key" },
  });
  const presetSecret = await makeSecret({
    name: `${name}-preset`,
    secret: { token: "source-preset-token" },
  });

  const source = await InternalMcpCatalogModel.create(
    {
      name,
      serverType: "local",
      clientSecretId: clientSecret.id,
      localConfigSecretId: localConfigSecret.id,
      presetSecretId: presetSecret.id,
      localConfig: {
        command: "node",
        arguments: ["server.js"],
        environment: [
          { key: "API_KEY", type: "secret", promptOnInstallation: false },
        ],
      },
    },
    { organizationId, authorId },
  );

  return { source, clientSecret, localConfigSecret, presetSecret };
}

describe("Internal MCP Catalog - secret carry-over on clone", () => {
  test("clones all three secret kinds as independent copies with same values", async ({
    makeOrganization,
    makeUser,
    makeSecret,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const { source, clientSecret, localConfigSecret, presetSecret } =
      await makeSourceWithAllSecrets({
        organizationId: org.id,
        authorId: user.id,
        makeSecret,
        name: "clone-src-all",
      });

    const clone = await InternalMcpCatalogModel.create(
      {
        name: "clone-src-all-copy",
        serverType: "local",
        clonedFrom: source.id,
      },
      { organizationId: org.id, authorId: user.id },
    );

    // All three carried over...
    expect(clone.clientSecretId).toBeTruthy();
    expect(clone.localConfigSecretId).toBeTruthy();
    expect(clone.presetSecretId).toBeTruthy();

    // ...as independent rows (distinct ids)...
    expect(clone.clientSecretId).not.toBe(clientSecret.id);
    expect(clone.localConfigSecretId).not.toBe(localConfigSecret.id);
    expect(clone.presetSecretId).not.toBe(presetSecret.id);

    // ...holding the same values.
    const clientCopy = await secretManager().getSecret(
      clone.clientSecretId as string,
    );
    const localCopy = await secretManager().getSecret(
      clone.localConfigSecretId as string,
    );
    const presetCopy = await secretManager().getSecret(
      clone.presetSecretId as string,
    );
    expect(clientCopy?.secret).toEqual({
      client_secret: "source-client-secret",
    });
    expect(localCopy?.secret).toEqual({ API_KEY: "source-api-key" });
    expect(presetCopy?.secret).toEqual({ token: "source-preset-token" });
  });

  test("editing a cloned secret does not affect the source", async ({
    makeOrganization,
    makeUser,
    makeSecret,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const { source, localConfigSecret } = await makeSourceWithAllSecrets({
      organizationId: org.id,
      authorId: user.id,
      makeSecret,
      name: "clone-src-independent",
    });

    const clone = await InternalMcpCatalogModel.create(
      {
        name: "clone-src-independent-copy",
        serverType: "local",
        clonedFrom: source.id,
      },
      { organizationId: org.id, authorId: user.id },
    );

    await secretManager().updateSecret(clone.localConfigSecretId as string, {
      API_KEY: "edited-on-clone",
    });

    const sourceSecret = await secretManager().getSecret(localConfigSecret.id);
    expect(sourceSecret?.secret).toEqual({ API_KEY: "source-api-key" });
  });

  test("a user-supplied secret on the clone payload wins over the source's", async ({
    makeOrganization,
    makeUser,
    makeSecret,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const { source, clientSecret } = await makeSourceWithAllSecrets({
      organizationId: org.id,
      authorId: user.id,
      makeSecret,
      name: "clone-src-override",
    });

    const overrideSecret = await makeSecret({
      name: "override-client",
      secret: { client_secret: "user-supplied-secret" },
    });

    const clone = await InternalMcpCatalogModel.create(
      {
        name: "clone-src-override-copy",
        serverType: "local",
        clonedFrom: source.id,
        clientSecretId: overrideSecret.id,
      },
      { organizationId: org.id, authorId: user.id },
    );

    // The supplied id is kept, not replaced by a copy of the source's.
    expect(clone.clientSecretId).toBe(overrideSecret.id);
    expect(clone.clientSecretId).not.toBe(clientSecret.id);
    // The other slots still inherit from the source.
    expect(clone.localConfigSecretId).toBeTruthy();
    expect(clone.presetSecretId).toBeTruthy();
  });

  test("cloning a source with no secrets leaves the clone's slots empty", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();
    const source = await InternalMcpCatalogModel.create(
      { name: "clone-src-none", serverType: "remote" },
      { organizationId: org.id, authorId: user.id },
    );

    const clone = await InternalMcpCatalogModel.create(
      {
        name: "clone-src-none-copy",
        serverType: "remote",
        clonedFrom: source.id,
      },
      { organizationId: org.id, authorId: user.id },
    );

    expect(clone.clientSecretId).toBeNull();
    expect(clone.localConfigSecretId).toBeNull();
    expect(clone.presetSecretId).toBeNull();
  });

  test("skips externally-backed (vault/BYOS) source secrets instead of materializing them", async ({
    makeOrganization,
    makeUser,
  }) => {
    const org = await makeOrganization();
    const user = await makeUser();

    // A BYOS secret stores a vault path reference, not the value itself.
    const byosSecret = await SecretModel.create({
      name: "byos-src",
      secret: { client_secret: "secret/data/path#client_secret" },
      isByosVault: true,
    });
    const source = await InternalMcpCatalogModel.create(
      {
        name: "clone-src-byos",
        serverType: "remote",
        clientSecretId: byosSecret.id,
      },
      { organizationId: org.id, authorId: user.id },
    );

    const clone = await InternalMcpCatalogModel.create(
      {
        name: "clone-src-byos-copy",
        serverType: "remote",
        clonedFrom: source.id,
      },
      { organizationId: org.id, authorId: user.id },
    );

    // The reference is not resolved and copied into a new DB row.
    expect(clone.clientSecretId).toBeNull();
  });
});
