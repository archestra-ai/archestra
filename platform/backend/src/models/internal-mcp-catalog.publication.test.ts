import { vi } from "vitest";
import { secretManager } from "@/secrets-manager";
import {
  CatalogSecretStaging,
  extractLocalConfigSecrets,
} from "@/services/mcp-catalog-secrets";
import { expect, test } from "@/test";
import InternalMcpCatalogModel from "./internal-mcp-catalog";
import McpServerModel from "./mcp-server";
import SecretModel from "./secret";

test("stale ordinary authoring cannot publish over newly privileged YAML or change its secret bag", async ({
  makeInternalMcpCatalog,
}) => {
  const bag = await secretManager().createSecret(
    { TOKEN: "approved-value" },
    "live-catalog-bag",
  );
  const catalog = await makeInternalMcpCatalog({
    serverType: "local",
    localConfig: {
      command: "node",
      environment: [
        { key: "TOKEN", type: "secret", promptOnInstallation: false },
      ],
    },
    localConfigSecretId: bag.id,
  });
  const reviewed = await InternalMcpCatalogModel.findById(catalog.id, {
    expandSecrets: false,
  });
  expect(reviewed).not.toBeNull();
  if (!reviewed) throw new Error("Missing fixture");
  const staging = new CatalogSecretStaging();
  const staged = await extractLocalConfigSecrets({
    existingSecretId: bag.id,
    catalogName: catalog.name,
    staging,
    localConfig: {
      command: "sh",
      environment: [
        {
          key: "TOKEN",
          type: "secret",
          promptOnInstallation: false,
          value: "unapproved-value",
        },
      ],
    },
  });
  const elevated = await InternalMcpCatalogModel.publishReviewed({
    original: reviewed,
    updates: {
      deploymentSpecYaml:
        "spec: {template: {spec: {serviceAccountName: approved-account}}}",
    },
  });
  await expect(
    InternalMcpCatalogModel.publishReviewed({
      original: reviewed,
      updates: {
        localConfig: staged.localConfig,
        localConfigSecretId: staged.secretId,
      },
    }),
  ).rejects.toMatchObject({ statusCode: 409 });
  await staging.dispose();
  const current = await InternalMcpCatalogModel.findById(catalog.id, {
    expandSecrets: false,
  });
  expect(current?.deploymentSpecYaml).toBe(
    elevated.catalogItem.deploymentSpecYaml,
  );
  expect(current?.localConfig?.command).toBe("node");
  expect(current?.localConfigSecretId).toBe(bag.id);
  expect((await secretManager().getSecret(bag.id))?.secret).toEqual({
    TOKEN: "approved-value",
  });
  expect(await SecretModel.findById(staged.secretId ?? "")).toBeNull();
});

test("a reviewed rename and config are published together, and a stale rename has no side effects", async ({
  makeInternalMcpCatalog,
  makeMcpServer,
}) => {
  const catalog = await makeInternalMcpCatalog({
    serverType: "local",
    localConfig: { command: "node" },
  });
  const install = await makeMcpServer({
    catalogId: catalog.id,
    serverType: "local",
    scope: "org",
    name: catalog.name,
  });
  const reviewed = await InternalMcpCatalogModel.findById(catalog.id, {
    expandSecrets: false,
  });
  if (!reviewed) throw new Error("Missing fixture");
  const published = await InternalMcpCatalogModel.publishReviewed({
    original: reviewed,
    updates: { localConfig: { command: "python" } },
    rename: {
      newName: "renamed-catalog",
      flagReinstallRequired: false,
      freezeDeploymentNames: true,
    },
  });
  expect(published.catalogItem.name).toBe("renamed-catalog");
  expect(published.catalogItem.localConfig?.command).toBe("python");
  const renamedInstall = await McpServerModel.findById(install.id);
  expect(renamedInstall?.name).toContain("renamed-catalog");
  expect(renamedInstall?.deploymentName).toBeTruthy();
  await expect(
    InternalMcpCatalogModel.publishReviewed({
      original: reviewed,
      updates: {},
      rename: {
        newName: "stale-catalog",
        flagReinstallRequired: false,
        freezeDeploymentNames: true,
      },
    }),
  ).rejects.toMatchObject({ statusCode: 409 });
  expect((await McpServerModel.findById(install.id))?.name).toBe(
    renamedInstall?.name,
  );
});

test("cleanup preserves a committed bag when the caller has not received publication success", async ({
  makeInternalMcpCatalog,
}) => {
  const staging = new CatalogSecretStaging();
  const bag = await staging.createSecret(
    { TOKEN: "published" },
    "published-catalog-bag",
  );
  await makeInternalMcpCatalog({ localConfigSecretId: bag.id });
  await staging.dispose();
  expect((await SecretModel.findById(bag.id))?.secret).toEqual({
    TOKEN: "published",
  });
});

test("a stale administrator cannot attach privileges to an ordinary author's newer executable", async ({
  makeInternalMcpCatalog,
}) => {
  const catalog = await makeInternalMcpCatalog({
    serverType: "local",
    localConfig: { command: "node" },
  });
  const reviewed = await InternalMcpCatalogModel.findById(catalog.id, {
    expandSecrets: false,
  });
  if (!reviewed) throw new Error("Missing fixture");
  await InternalMcpCatalogModel.publishReviewed({
    original: reviewed,
    updates: { localConfig: { command: "python" } },
  });
  await expect(
    InternalMcpCatalogModel.publishReviewed({
      original: reviewed,
      updates: {
        deploymentSpecYaml:
          "spec: {template: {spec: {serviceAccountName: approved-account}}}",
      },
    }),
  ).rejects.toMatchObject({ statusCode: 409 });
  const current = await InternalMcpCatalogModel.findById(catalog.id, {
    expandSecrets: false,
  });
  expect(current?.localConfig?.command).toBe("python");
  expect(current?.deploymentSpecYaml).toBeNull();
});

test("failed runtime publication rolls back its preceding rename cascade", async ({
  makeInternalMcpCatalog,
  makeMcpServer,
}) => {
  const catalog = await makeInternalMcpCatalog({
    serverType: "local",
    localConfig: { command: "node" },
  });
  const install = await makeMcpServer({
    catalogId: catalog.id,
    serverType: "local",
    scope: "org",
    name: catalog.name,
  });
  const reviewed = await InternalMcpCatalogModel.findById(catalog.id, {
    expandSecrets: false,
  });
  if (!reviewed) throw new Error("Missing fixture");
  await expect(
    InternalMcpCatalogModel.publishReviewed({
      original: reviewed,
      updates: { environmentId: crypto.randomUUID() },
      rename: {
        newName: "uncommitted-rename",
        flagReinstallRequired: true,
        freezeDeploymentNames: true,
      },
    }),
  ).rejects.toThrow();
  expect((await InternalMcpCatalogModel.findById(catalog.id))?.name).toBe(
    catalog.name,
  );
  const currentInstall = await McpServerModel.findById(install.id);
  expect(currentInstall?.name).toBe(install.name);
  expect(currentInstall?.deploymentName).toBe(install.deploymentName);
  expect(currentInstall?.reinstallRequired).toBe(install.reinstallRequired);
});

test("publication cleans superseded staged bags while retaining the final catalog bag", async ({
  makeInternalMcpCatalog,
}) => {
  const staging = new CatalogSecretStaging();
  const unused = await staging.createSecret(
    { TOKEN: "intermediate" },
    "intermediate-bag",
  );
  const retained = await staging.createSecret(
    { TOKEN: "published" },
    "published-bag",
  );
  await makeInternalMcpCatalog({ localConfigSecretId: retained.id });
  await staging.publish();
  await staging.dispose();
  expect(await SecretModel.findById(unused.id)).toBeNull();
  expect((await SecretModel.findById(retained.id))?.secret).toEqual({
    TOKEN: "published",
  });
});

test("a clone cannot be authorized until all inherited secret values are composed", async ({
  makeInternalMcpCatalog,
}) => {
  const sourceBag = await secretManager().createSecret(
    { INHERITED: "source-value", OVERRIDE: "source-default" },
    "clone-source-values",
  );
  const suppliedBag = await secretManager().createSecret(
    { OVERRIDE: "clone-value" },
    "clone-supplied-values",
  );
  const source = await makeInternalMcpCatalog({
    serverType: "local",
    localConfig: { command: "node" },
    localConfigSecretId: sourceBag.id,
  });
  const cloneId = crypto.randomUUID();
  const findSecret = SecretModel.findById.bind(SecretModel);
  let observedPreparation = false;
  let exposedDuringPreparation = false;
  const spy = vi
    .spyOn(SecretModel, "findById")
    .mockImplementation(async (id) => {
      if (id === sourceBag.id && !observedPreparation) {
        observedPreparation = true;
        const exposed = await InternalMcpCatalogModel.findById(cloneId, {
          expandSecrets: false,
        });
        exposedDuringPreparation = exposed !== null;
        if (exposed)
          await InternalMcpCatalogModel.publishReviewed({
            original: exposed,
            updates: {
              localConfig: {
                command: "node",
                serviceAccount: "approved-runtime",
              },
            },
          });
      }
      return findSecret(id);
    });
  try {
    const clone = await InternalMcpCatalogModel.create({
      id: cloneId,
      name: "prepared-clone",
      serverType: "local",
      clonedFrom: source.id,
      localConfig: { command: "node" },
      localConfigSecretId: suppliedBag.id,
    });
    expect(observedPreparation).toBe(true);
    expect(exposedDuringPreparation).toBe(false);
    expect(clone.localConfig?.serviceAccount).toBeUndefined();
    expect((await findSecret(clone.localConfigSecretId ?? ""))?.secret).toEqual(
      { INHERITED: "source-value", OVERRIDE: "clone-value" },
    );
    expect((await findSecret(suppliedBag.id))?.secret).toEqual({
      OVERRIDE: "clone-value",
    });
  } finally {
    spy.mockRestore();
  }
});

test("an unsuccessful clone insertion cleans its prepared bags without modifying source values", async ({
  makeInternalMcpCatalog,
}) => {
  const sourceBag = await secretManager().createSecret(
    { TOKEN: "source-value" },
    "clone-source-bag",
  );
  const source = await makeInternalMcpCatalog({
    serverType: "local",
    localConfig: { command: "node" },
    localConfigSecretId: sourceBag.id,
  });
  const before = await SecretModel.count();
  await expect(
    InternalMcpCatalogModel.create({
      id: source.id,
      name: "duplicate-id-clone",
      serverType: "local",
      clonedFrom: source.id,
      localConfig: { command: "node" },
    }),
  ).rejects.toThrow();
  expect(await SecretModel.count()).toBe(before);
  expect((await SecretModel.findById(sourceBag.id))?.secret).toEqual({
    TOKEN: "source-value",
  });
});
