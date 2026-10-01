import { HttpResponse, http } from "msw";
import InternalMcpCatalogModel from "@/models/internal-mcp-catalog";
import SecretModel from "@/models/secret";
import { expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import type { VaultConfig } from "@/types";
import ReadonlyVaultSecretManager from "./readonly-vault.ee";
import VaultSecretManager from "./vault.ee";

// biome-ignore lint/correctness/useHookAtTopLevel: Vitest lifecycle fixture
const server = useMswServer();

test("managed Vault retirement preserves referenced bags and removes an unreferenced bag from both stores", async ({
  makeInternalMcpCatalog,
}) => {
  const bag = await SecretModel.create({
    name: "retired_vault",
    isVault: true,
    secret: {},
  });
  const catalog = await makeInternalMcpCatalog({ localConfigSecretId: bag.id });
  const manager = new VaultSecretManager(vaultConfig);
  let deletions = 0;
  server.use(
    http.delete(
      `https://vault.example/v1/secret/metadata/catalog/retired_vault-${bag.id}`,
      () => {
        deletions++;
        return new HttpResponse(null, { status: 204 });
      },
    ),
  );

  expect(await manager.deleteSecret(bag.id, { onlyIfUnreferenced: true })).toBe(
    false,
  );
  expect(deletions).toBe(0);
  expect(await SecretModel.findById(bag.id)).not.toBeNull();
  await InternalMcpCatalogModel.update(catalog.id, {
    localConfigSecretId: null,
  });
  expect(await manager.deleteSecret(bag.id, { onlyIfUnreferenced: true })).toBe(
    true,
  );
  expect(deletions).toBe(1);
  expect(await SecretModel.findById(bag.id)).toBeNull();
});

test("failed managed Vault retirement retains its database record for a retry", async () => {
  const bag = await SecretModel.create({
    name: "retry_vault",
    isVault: true,
    secret: {},
  });
  const manager = new VaultSecretManager(vaultConfig);
  const url = `https://vault.example/v1/secret/metadata/catalog/retry_vault-${bag.id}`;
  server.use(
    http.delete(url, () =>
      HttpResponse.json({ errors: ["Unavailable"] }, { status: 503 }),
    ),
  );
  await expect(
    manager.deleteSecret(bag.id, { onlyIfUnreferenced: true }),
  ).rejects.toMatchObject({ statusCode: 503 });
  expect(await SecretModel.findById(bag.id)).not.toBeNull();

  server.use(http.delete(url, () => new HttpResponse(null, { status: 204 })));
  expect(await manager.deleteSecret(bag.id, { onlyIfUnreferenced: true })).toBe(
    true,
  );
  expect(await SecretModel.findById(bag.id)).toBeNull();
});

test("BYOS retirement removes only the unreferenced local pointer without accessing external Vault", async ({
  makeInternalMcpCatalog,
}) => {
  const bag = await SecretModel.create({
    name: "byos_reference",
    isByosVault: true,
    secret: { TOKEN: "secret/shared#token" },
  });
  const catalog = await makeInternalMcpCatalog({ localConfigSecretId: bag.id });
  const manager = new ReadonlyVaultSecretManager(vaultConfig);
  // No HTTP handlers: any access to the externally owned secret fails this test.
  expect(await manager.deleteSecret(bag.id, { onlyIfUnreferenced: true })).toBe(
    false,
  );
  expect((await SecretModel.findById(bag.id))?.secret).toEqual(bag.secret);
  await InternalMcpCatalogModel.update(catalog.id, {
    localConfigSecretId: null,
  });
  expect(await manager.deleteSecret(bag.id, { onlyIfUnreferenced: true })).toBe(
    true,
  );
  expect(await SecretModel.findById(bag.id)).toBeNull();
});

const vaultConfig: VaultConfig = {
  address: "https://vault.example",
  authMethod: "token",
  kvVersion: "2",
  token: "test-token",
  secretPath: "secret/data/catalog",
  k8sTokenPath: "/var/run/secrets/kubernetes.io/serviceaccount/token",
  k8sMountPoint: "kubernetes",
  awsMountPoint: "aws",
  awsRegion: "us-east-1",
  awsStsEndpoint: "https://sts.amazonaws.com",
};
