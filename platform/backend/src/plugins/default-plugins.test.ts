import { ADMIN_ROLE_NAME } from "@archestra/shared";
import { vi } from "vitest";
import { PluginModel } from "@/models";
import { afterEach, expect, test } from "@/test";
import { stubGithub } from "@/test/github-skills-stub";
import { seedDefaultPlugins } from "./default-plugins";

vi.mock("@/config", async () =>
  (await import("@/test/mocks/config")).configModuleMock({
    plugins: { enabled: true },
  }),
);

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubOpenAppa(): void {
  stubGithub([
    {
      owner: "archestra-ai",
      repo: "OpenAPPA",
      commitSha: "52906eb275a9f08106bfaf86a322f8b078be3dbd",
      files: {
        ".claude-plugin/marketplace.json": JSON.stringify({
          plugins: [
            {
              name: "appa-runtime",
              source: "./integrations/claude-code/plugin",
            },
          ],
        }),
        "integrations/claude-code/plugin/hooks/hooks.json": "{}\n",
        "integrations/claude-code/plugin/hooks/ensure-runtime.sh":
          "#!/bin/sh\ntrue\n",
        "integrations/claude-code/plugin/.mcp.json": "{}\n",
      },
      modes: {
        "integrations/claude-code/plugin/hooks/ensure-runtime.sh": "100755",
      },
    },
  ]);
}

async function findOpenAppa(organizationId: string) {
  return PluginModel.findByMarketplaceIdentity({
    organizationId,
    marketplaceRepo: "archestra-ai/OpenAPPA",
    marketplacePath: ".claude-plugin/marketplace.json",
    marketplacePluginName: "appa-runtime",
  });
}

test("seeds OpenAPPA once as an ordinary tracked GitHub import", async ({
  makeOrganization,
  makeUser,
  makeMember,
}) => {
  const organization = await makeOrganization();
  const admin = await makeUser();
  await makeMember(admin.id, organization.id, { role: ADMIN_ROLE_NAME });
  stubOpenAppa();

  await seedDefaultPlugins();
  await seedDefaultPlugins();

  const plugin = await findOpenAppa(organization.id);
  expect(plugin).toMatchObject({
    displayName: "OpenAPPA",
    scope: "org",
    clientType: "claude-code",
    supportedPlatforms: ["posix"],
    sourceKind: "github",
    sourceRepo: "archestra-ai/OpenAPPA",
    sourceRef: "main",
    sourceSubdir: "integrations/claude-code/plugin",
    sourceMarketplaceRepo: "archestra-ai/OpenAPPA",
    sourceMarketplacePath: ".claude-plugin/marketplace.json",
    sourceMarketplacePluginName: "appa-runtime",
    githubSyncInterval: "1d",
    githubSyncRef: "main",
    sourceId: null,
    approvedBy: admin.id,
  });
  const pluginWithFiles = await PluginModel.findById({
    id: plugin?.id ?? "",
    organizationId: organization.id,
  });
  expect(pluginWithFiles?.files).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: ".mcp.json" }),
      expect.objectContaining({
        path: "hooks/ensure-runtime.sh",
        mode: "100755",
      }),
      expect.objectContaining({ path: "hooks/hooks.json" }),
    ]),
  );
});

test("converts a legacy managed row into an ordinary marketplace import", async ({
  makeOrganization,
  makeUser,
  makeMember,
}) => {
  const organization = await makeOrganization();
  const admin = await makeUser();
  await makeMember(admin.id, organization.id, { role: ADMIN_ROLE_NAME });
  await PluginModel.create({
    organizationId: organization.id,
    userId: admin.id,
    pluginSlug: "openappa",
    sourceId: "managed:openappa:claude-code",
    input: {
      displayName: "OpenAPPA",
      description: "Open Agent Policy Protocol integration for Claude Code",
      clientType: "claude-code",
      files: [
        {
          path: "hooks/hooks.json",
          content: "{}\n",
          encoding: "utf8",
          mode: "100644",
        },
      ],
    },
    source: {
      repo: "archestra-ai/OpenAPPA",
      ref: "52906eb275a9f08106bfaf86a322f8b078be3dbd",
      sha: "52906eb275a9f08106bfaf86a322f8b078be3dbd",
      subdir: "integrations/claude-code/plugin",
      exclude: [],
    },
  });
  stubOpenAppa();

  await seedDefaultPlugins();

  const plugin = await findOpenAppa(organization.id);
  expect(plugin).toMatchObject({
    sourceId: null,
    sourceRef: "main",
    githubSyncRef: "main",
    githubSyncInterval: "1d",
    sourceMarketplacePluginName: "appa-runtime",
  });
});

test("does not recreate OpenAPPA after an administrator deletes it", async ({
  makeOrganization,
  makeUser,
  makeMember,
}) => {
  const organization = await makeOrganization();
  const admin = await makeUser();
  await makeMember(admin.id, organization.id, { role: ADMIN_ROLE_NAME });
  stubOpenAppa();
  await seedDefaultPlugins();
  const plugin = await findOpenAppa(organization.id);
  expect(plugin).not.toBeNull();
  await PluginModel.delete({
    id: plugin?.id ?? "",
    organizationId: organization.id,
  });

  await seedDefaultPlugins();

  expect(
    (
      await PluginModel.findByOrganization({ organizationId: organization.id })
    ).some((item) => item.displayName === "OpenAPPA"),
  ).toBe(false);
  expect((await findOpenAppa(organization.id))?.deletedAt).not.toBeNull();
});
