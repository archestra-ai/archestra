import { ADMIN_ROLE_NAME } from "@archestra/shared";
import { vi } from "vitest";
import config from "@/config";
import OpenAppaBatteryInstallModel from "@/models/openappa-battery-install";
import OpenAppaEffectivePolicyModel from "@/models/openappa-effective-policy";
import ToolModel from "@/models/tool";
import { OPENAPPA_HELPERS_PREFIX } from "@/routes/route-paths";
import { guardrailsPolicyService } from "@/services/guardrails-policy";
import { beforeEach, describe, expect, test } from "@/test";
import { openappaBatteriesService } from "./batteries";

describe("battery attachment after a tool sync", () => {
  beforeEach(() => {
    config.openappa.enabled = true;
  });

  test("a catalog matching a bundled battery is attached once and its organization recomposed", async ({
    makeOrganization,
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "GitHub",
      serverUrl: "https://api.githubcopilot.com/mcp/",
    });
    await makeTool({
      catalogId: catalog.id,
      name: "github__get_me",
      rawName: "get_me",
    });
    // Two syncs of one catalog can overlap; the second must neither duplicate nor fail.
    await Promise.all([
      openappaBatteriesService.onCatalogToolsChanged(catalog.id),
      openappaBatteriesService.onCatalogToolsChanged(catalog.id),
    ]);
    await openappaBatteriesService.onCatalogToolsChanged(catalog.id);
    const installs = await OpenAppaBatteryInstallModel.list(organizationId);
    expect(installs).toHaveLength(1);
    expect(installs[0]).toMatchObject({
      batteryName: "github",
      catalogId: catalog.id,
      enabled: true,
    });

    // A name alone attaches the battery disabled, for an operator to confirm.
    const byName = await makeInternalMcpCatalog({
      organizationId,
      name: "Slack bridge test",
      serverUrl: "https://mcp.example.com/chat",
    });
    await openappaBatteriesService.onCatalogToolsChanged(byName.id);
    expect(
      (await OpenAppaBatteryInstallModel.list(organizationId)).find(
        (install) => install.catalogId === byName.id,
      ),
    ).toMatchObject({ batteryName: "slack", enabled: false });
    expect(
      await OpenAppaEffectivePolicyModel.find(organizationId),
    ).toMatchObject({ rootRevision: 0, lastError: null });
    // A deleted catalog leaves the composition: its tools no longer target
    // the battery namespace, so the stored composition changes with it. The
    // notion battery has no helpers, so its install is active at once.
    const docs = await makeInternalMcpCatalog({
      organizationId,
      name: "Docs",
      serverUrl: "https://mcp.notion.com/mcp",
    });
    await makeTool({
      catalogId: docs.id,
      name: "notion__search",
      rawName: "search",
    });
    await openappaBatteriesService.onCatalogToolsChanged(docs.id);
    const before = await openappaBatteriesService.recompile(organizationId);
    await ToolModel.softDeleteByCatalog(docs.id, new Date());
    const after = await openappaBatteriesService.recompile(organizationId);
    expect(after.installFingerprint).not.toBe(before.installFingerprint);
    await expect(
      OpenAppaBatteryInstallModel.organizationIdsForCatalog(catalog.id),
    ).resolves.toEqual([organizationId]);
  });

  test("a catalog standing for no battery attaches nothing", async ({
    makeOrganization,
    makeInternalMcpCatalog,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Internal wiki",
      serverUrl: "https://wiki.example.com/mcp",
    });
    await openappaBatteriesService.onCatalogToolsChanged(catalog.id);
    expect(await OpenAppaBatteryInstallModel.list(organizationId)).toEqual([]);
    expect(await OpenAppaEffectivePolicyModel.find(organizationId)).toBeNull();
  });
});

describe("bundled batteries", () => {
  beforeEach(() => {
    config.openappa.enabled = true;
  });

  test("every bundled battery composes into the initial policy", async ({
    makeOrganization,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const root = await guardrailsPolicyService.get(organizationId);
    const native = await import("@archestra/openappa-rs");
    // Composing is a direct addon call here, so it owes the addon the same
    // thing the service owes it: the bearer, in the environment, first.
    const tokenEnv = openappaBatteriesService.publishBridgeToken();
    const bundled = await native.listBundledOpenappaBatteries();
    const names = bundled.map((battery) => battery.name);
    expect(names).toContain("github");
    // A battery for another host's own tools has nothing to say here.
    expect(names).not.toContain("claude-code");
    for (const battery of bundled) {
      const composed = await native.composeOpenappaPolicy({
        root: root.content,
        serverAliases: battery.namespaces.map((alias) => ({
          alias,
          targets: [`${alias.replaceAll("-", "_")}_prod`],
        })),
        batteries: [
          {
            name: battery.name,
            policy: battery.policy,
            helpers:
              battery.externals.length > 0
                ? {
                    urlBase: `http://127.0.0.1:${config.api.port}${OPENAPPA_HELPERS_PREFIX}/install`,
                    tokenEnv,
                  }
                : undefined,
          },
        ],
      });
      expect(composed.errors, battery.name).toEqual([]);
    }
  });
});

describe("composing an organization's effective policy", () => {
  beforeEach(() => {
    config.openappa.enabled = true;
  });

  test("a composition publishes the bridge bearer the runtime resolves for a helper", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeInternalMcpCatalog,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const userId = (await makeUser()).id;
    await makeMember(userId, organizationId, { role: ADMIN_ROLE_NAME });
    const catalogId = (await makeInternalMcpCatalog({ organizationId })).id;
    await installUploadedBattery({
      organizationId,
      userId,
      catalogId,
      policy: batteryPolicy("acme.check"),
    });
    const [battery] =
      await openappaBatteriesService.listBatteries(organizationId);
    expect(battery?.installs[0]?.status).toBe("active");

    // The runtime resolves a composed `token_env` from this process's
    // environment and refuses the document when it is unset, so composing has
    // to publish the bearer rather than inherit it from an earlier import.
    vi.stubEnv(BRIDGE_TOKEN_ENV, undefined);
    const policy = await openappaBatteriesService.recompile(organizationId);

    expect(policy.lastError).toBeNull();
    expect(process.env[BRIDGE_TOKEN_ENV]).toBe(
      openappaBatteriesService.bridgeToken,
    );
  });

  test("a battery the runtime refuses records the refusal and leaves the root enforced", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeInternalMcpCatalog,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const userId = (await makeUser()).id;
    await makeMember(userId, organizationId, { role: ADMIN_ROLE_NAME });
    const catalogId = (await makeInternalMcpCatalog({ organizationId })).id;
    const root = await guardrailsPolicyService.get(organizationId);
    await installUploadedBattery({
      organizationId,
      userId,
      catalogId,
      // The root already declares the `noop` annotator, so composing this
      // battery under it names one external twice and the runtime refuses it.
      policy: batteryPolicy("noop"),
    });

    const policy = await openappaBatteriesService.recompile(organizationId);

    expect(policy.lastError).toBeTruthy();
    expect(policy.lastErrorAt).toBeInstanceOf(Date);
    expect(policy.content).toBe(root.content);
    expect(
      (await OpenAppaEffectivePolicyModel.find(organizationId))?.lastError,
    ).toBe(policy.lastError);
  });
});

const BRIDGE_TOKEN_ENV = "APPA_ARCHESTRA_BRIDGE_TOKEN";

const BATTERY_MANIFEST = `schema = 1
name = "acme"
description = "Acme battery under test"

[battery]
policy = "appa.toml"
hosts = ["claude-code"]
namespaces = ["acme"]
helpers = ["check.py"]
`;

/**
 * A battery governing one MCP tool whose single annotator is served by one
 * helper command and needs no credential, so its install is active on its own.
 */
function batteryPolicy(externalName: string) {
  return `[policy]
version = 2

[[policy.tool]]
name = "mcp/acme/list"
delta = {}

[externals.annotators."${externalName}"]
command = ["python3", "check.py"]
`;
}

/** Upload the acme battery with `policy` and install it, enabled, on `catalogId`. */
async function installUploadedBattery(params: {
  organizationId: string;
  userId: string;
  catalogId: string;
  policy: string;
}) {
  const { organizationId, userId, catalogId } = params;
  await openappaBatteriesService.uploadPackage({
    userId,
    organizationId,
    name: "acme",
    files: [
      { path: "appa-package.toml", text: BATTERY_MANIFEST },
      { path: "appa.toml", text: params.policy },
      { path: "check.py", text: "print('{}')\n" },
    ],
  });
  const install = await OpenAppaBatteryInstallModel.createIfAbsent({
    organizationId,
    batteryName: "acme",
    catalogId,
    enabled: true,
    credentialBindings: {},
  });
  if (!install) throw new Error("the battery install already existed");
  return install;
}
