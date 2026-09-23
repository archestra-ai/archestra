import { createHash } from "node:crypto";
import { ADMIN_ROLE_NAME } from "@archestra/shared";
import { and, eq } from "drizzle-orm";
import config from "@/config";
import db, { schema } from "@/database";
import GuardrailsPolicyModel from "@/models/guardrails-policy";
import OpenAppaBatteryInstallModel from "@/models/openappa-battery-install";
import OpenAppaBatteryPackageModel from "@/models/openappa-battery-package";
import OpenAppaEffectivePolicyModel from "@/models/openappa-effective-policy";
import { guardrailsPolicyService } from "@/services/guardrails-policy";
import { beforeEach, describe, expect, test } from "@/test";
import { openappaBatteriesService } from "./batteries";
import {
  helperUrlBase,
  openappaDeclarations,
  packageContentHash,
} from "./declarations";

const BRIDGE_TOKEN_ENV = "APPA_ARCHESTRA_BRIDGE_TOKEN";

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
    const tokenEnv = openappaDeclarations.publishBridgeToken();
    const bundled = await native.listBundledOpenappaBatteries();
    const names = bundled.map((battery) => battery.name);
    expect(names).toContain("github");
    // A battery for another host's own tools has nothing to say here.
    expect(names).not.toContain("claude-code");
    for (const battery of bundled) {
      const entry = `batteries/${battery.name}/appa.toml`;
      const aliases = battery.namespaces
        .map(
          (namespace) =>
            `${namespace} = ["${namespace.replaceAll("-", "_")}_prod"]`,
        )
        .join("\n");
      const composed = await native.composeOpenappaPolicy({
        root: `include = ["${entry}"]\n\n[server_aliases]\n${aliases}\n\n${root.content}`,
        batteries: [
          {
            entry,
            name: battery.name,
            policy: battery.policy,
            helpers:
              battery.externals.length > 0
                ? { urlBase: "http://127.0.0.1:9000/helpers/install", tokenEnv }
                : undefined,
          },
        ],
      });
      expect(composed.errors, battery.name).toEqual([]);
    }
  });
});

describe("composing an organization's declarations", () => {
  beforeEach(() => {
    config.openappa.enabled = true;
  });

  test("a recompose derives one row per bound catalog and keeps its id across recomposes", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const userId = (await makeUser()).id;
    await makeMember(userId, organizationId, { role: ADMIN_ROLE_NAME });
    const first = await makeInternalMcpCatalog({
      organizationId,
      name: "Acme prod",
    });
    const second = await makeInternalMcpCatalog({
      organizationId,
      name: "Acme sandbox",
    });
    await makeTool({
      catalogId: first.id,
      name: "acme_prod__list",
      rawName: "list",
    });
    await makeTool({
      catalogId: second.id,
      name: "acme_sandbox__list",
      rawName: "list",
    });
    const { entry } = await uploadAcme({ organizationId, userId });
    await declare({
      organizationId,
      userId,
      content: root(entry, ["acme_prod", "acme_sandbox"]),
    });

    const derived = await OpenAppaBatteryInstallModel.list(organizationId);
    expect(
      derived.map((row) => ({
        batteryName: row.batteryName,
        catalogId: row.catalogId,
        status: row.status,
      })),
    ).toEqual(
      expect.arrayContaining([
        { batteryName: "acme", catalogId: first.id, status: "active" },
        { batteryName: "acme", catalogId: second.id, status: "active" },
      ]),
    );
    expect(derived).toHaveLength(2);
    const owner = derived[0];

    // The helper endpoint of a battery names its earliest row, so that row's id
    // has to survive every later composition.
    const composed = await openappaBatteriesService.recompile(organizationId);
    expect(composed.lastError).toBeNull();
    expect(composed.content).toContain(`/${owner.id}/`);
    await openappaBatteriesService.recompile(organizationId);
    expect(
      (await OpenAppaBatteryInstallModel.list(organizationId)).map(
        (row) => row.id,
      ),
    ).toEqual(derived.map((row) => row.id));

    // Dropping a target drops its row, and with it the helper endpoint that
    // row served: the id the composed document named is gone.
    await declare({
      organizationId,
      userId,
      content: root(entry, ["acme_prod"]),
    });
    const remaining = await OpenAppaBatteryInstallModel.list(organizationId);
    expect(remaining.map((row) => row.catalogId)).toEqual([first.id]);
    const dropped = derived.find((row) => row.catalogId === second.id);
    if (!dropped) throw new Error("the second catalog derived no row");
    await expect(
      OpenAppaBatteryInstallModel.findById(dropped.id),
    ).resolves.toBeNull();

    // Removing the entry removes every row of the battery.
    const initial = await guardrailsPolicyService.get(organizationId);
    await declare({
      organizationId,
      userId,
      content: initial.content.replace(/include = \[[^\]]*\]/, "include = []"),
    });
    expect(await OpenAppaBatteryInstallModel.list(organizationId)).toEqual([]);
  });

  test("an entry that resolves to nothing composes as an empty battery", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const userId = (await makeUser()).id;
    await makeMember(userId, organizationId, { role: ADMIN_ROLE_NAME });
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Acme prod",
    });
    await makeTool({
      catalogId: catalog.id,
      name: "acme_prod__list",
      rawName: "list",
    });
    const uploaded = await uploadAcme({ organizationId, userId });
    await declare({
      organizationId,
      userId,
      content: root(uploaded.entry, ["acme_prod"]),
    });
    // The bytes the entry spells are deleted behind its back: the entry stays
    // as authored, so the composition keeps opening and the battery is off.
    await OpenAppaBatteryPackageModel.delete({
      organizationId,
      contentHash: uploaded.contentHash,
    });
    await OpenAppaEffectivePolicyModel.invalidate(organizationId);

    const policy = await openappaBatteriesService.recompile(organizationId);
    expect(policy.lastError).toBeNull();
    const declarations =
      await openappaBatteriesService.policyDeclarations(organizationId);
    expect(declarations.batteries).toEqual([
      expect.objectContaining({ name: "acme", status: "unavailable" }),
    ]);
  });

  test("a composition the runtime refuses marks every row refused", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const userId = (await makeUser()).id;
    await makeMember(userId, organizationId, { role: ADMIN_ROLE_NAME });
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Acme prod",
    });
    await makeTool({
      catalogId: catalog.id,
      name: "acme_prod__list",
      rawName: "list",
    });
    // The battery binds a helper to an annotator its policy never declares, so
    // the composed document is one the runtime refuses to open.
    const { entry } = await uploadAcme({
      organizationId,
      userId,
      broken: true,
    });
    const content = root(entry, ["acme_prod"]);
    // The refusal is a composition-level one, so it is not a save-time refusal:
    // the text is saved through the model and discovered at the recompose.
    await declare({ organizationId, userId, content, checked: false });

    const policy = await openappaBatteriesService.recompile(organizationId);

    expect(policy.lastError).toBeTruthy();
    expect(policy.lastErrorAt).toBeInstanceOf(Date);
    expect(
      (await OpenAppaBatteryInstallModel.list(organizationId)).map(
        (row) => row.status,
      ),
    ).toEqual(["refused"]);
  });

  test("a document that answers one battery twice is refused, and one already stored derives one row", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const userId = (await makeUser()).id;
    await makeMember(userId, organizationId, { role: ADMIN_ROLE_NAME });
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Acme prod",
    });
    await makeTool({
      catalogId: catalog.id,
      name: "acme_prod__list",
      rawName: "list",
    });
    const first = await uploadAcme({ organizationId, userId });
    const second = await uploadAcme({
      organizationId,
      userId,
      note: "another version of the same battery",
    });
    const content = root([first.entry, second.entry], ["acme_prod"]);

    const validation = await guardrailsPolicyService.validate(content, {
      organizationId,
    });
    expect(validation.valid).toBe(false);
    expect(validation.errors).toHaveLength(1);
    expect(validation.errors[0]).toContain(first.entry);
    expect(validation.errors[0]).toContain(second.entry);
    await expect(
      guardrailsPolicyService.update({
        organizationId,
        userId,
        content,
        expectedRevision: (await guardrailsPolicyService.get(organizationId))
          .revision,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });

    // Text written before the check existed still has to recompose: one row per
    // catalog and battery, carrying the refusal rather than aborting the write.
    await declare({ organizationId, userId, content, checked: false });

    const policy = await openappaBatteriesService.recompile(organizationId);
    expect(policy.lastError).toBeTruthy();
    expect(
      (await OpenAppaBatteryInstallModel.list(organizationId)).map((row) => ({
        batteryName: row.batteryName,
        catalogId: row.catalogId,
        status: row.status,
      })),
    ).toEqual([
      { batteryName: "acme", catalogId: catalog.id, status: "refused" },
    ]);
  });

  test("reading the batteries of an unchanged policy rewrites no row", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const userId = (await makeUser()).id;
    await makeMember(userId, organizationId, { role: ADMIN_ROLE_NAME });
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Acme prod",
    });
    await makeTool({
      catalogId: catalog.id,
      name: "acme_prod__list",
      rawName: "list",
    });
    const { entry } = await uploadAcme({ organizationId, userId });
    await declare({
      organizationId,
      userId,
      content: root(entry, ["acme_prod"]),
    });
    const written = await OpenAppaBatteryInstallModel.list(organizationId);
    expect(written.map((row) => row.status)).toEqual(["active"]);

    const declarations =
      await openappaBatteriesService.policyDeclarations(organizationId);
    const listed = await openappaBatteriesService.listBatteries(organizationId);
    // The panel reads this one for the same catalog; it too may write nothing.
    await openappaBatteriesService.matchesForCatalog({
      organizationId,
      catalogId: catalog.id,
    });

    expect(declarations.batteries).toEqual([
      expect.objectContaining({ name: "acme", status: "active" }),
    ]);
    expect(
      listed.find((battery) => battery.name === "acme")?.installs,
    ).toHaveLength(1);
    expect(
      (await OpenAppaBatteryInstallModel.list(organizationId)).map((row) => ({
        id: row.id,
        updatedAt: row.updatedAt,
      })),
    ).toEqual(written.map((row) => ({ id: row.id, updatedAt: row.updatedAt })));
  });

  test("a stored version that no longer inspects falls back to the newest that does", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const userId = (await makeUser()).id;
    await makeMember(userId, organizationId, { role: ADMIN_ROLE_NAME });
    const readable = await uploadAcme({ organizationId, userId });
    await storeUnreadable({ organizationId, name: "acme" });

    const listed = await openappaBatteriesService.listBatteries(organizationId);

    expect(listed.find((battery) => battery.name === "acme")?.contentHash).toBe(
      readable.contentHash,
    );
  });

  test("a composition publishes the bridge bearer the runtime resolves for a helper", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const userId = (await makeUser()).id;
    await makeMember(userId, organizationId, { role: ADMIN_ROLE_NAME });
    const catalog = await makeInternalMcpCatalog({ organizationId });
    await makeTool({
      catalogId: catalog.id,
      name: "acme_prod__list",
      rawName: "list",
    });
    const { entry } = await uploadAcme({ organizationId, userId });
    await declare({
      organizationId,
      userId,
      content: root(entry, ["acme_prod"]),
    });

    // The runtime resolves a composed `token_env` from this process's
    // environment and refuses the document when it is unset, so composing has
    // to publish the bearer rather than inherit it from an earlier import.
    delete process.env[BRIDGE_TOKEN_ENV];
    await OpenAppaEffectivePolicyModel.invalidate(organizationId);
    const policy = await openappaBatteriesService.recompile(organizationId);

    expect(policy.lastError).toBeNull();
    expect(process.env[BRIDGE_TOKEN_ENV]).toBe(
      openappaDeclarations.bridgeToken,
    );
  });
});

describe("a battery made of annotators alone", () => {
  beforeEach(() => {
    config.openappa.enabled = true;
  });

  test("derives one organization-wide row that owns its helper and survives recomposes", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const userId = (await makeUser()).id;
    await makeMember(userId, organizationId, { role: ADMIN_ROLE_NAME });
    const uploaded = await uploadTagger({ organizationId, userId });
    await declare({
      organizationId,
      userId,
      content: root(uploaded.entry, []),
    });

    // The root's only rule routes every tool to `noop`: nothing consults the
    // battery's annotator, so it is not active, though its helper is composed.
    const [row, ...others] =
      await OpenAppaBatteryInstallModel.list(organizationId);
    expect(others).toEqual([]);
    expect(row).toMatchObject({
      batteryName: "tagger",
      catalogId: null,
      status: "unrouted",
    });
    const unrouted = await openappaBatteriesService.recompile(organizationId);
    expect(unrouted.lastError).toBeNull();
    expect(unrouted.content).toContain(helperUrlBase(row.id));

    await declare({
      organizationId,
      userId,
      content: root(uploaded.entry, [], { route: "tagger.call" }),
    });
    expect(await OpenAppaBatteryInstallModel.list(organizationId)).toEqual([
      expect.objectContaining({ id: row.id, status: "active" }),
    ]);
    const composed = await openappaBatteriesService.recompile(organizationId);
    expect(composed.lastError).toBeNull();
    expect(composed.content).toContain(helperUrlBase(row.id));
    await OpenAppaEffectivePolicyModel.invalidate(organizationId);
    await openappaBatteriesService.recompile(organizationId);
    expect(
      (await OpenAppaBatteryInstallModel.list(organizationId)).map(
        (install) => install.id,
      ),
    ).toEqual([row.id]);

    // Bytes that no longer resolve hold it back before anything else.
    await OpenAppaBatteryPackageModel.delete({
      organizationId,
      contentHash: uploaded.contentHash,
    });
    await OpenAppaEffectivePolicyModel.invalidate(organizationId);
    await openappaBatteriesService.recompile(organizationId);
    expect(
      (await openappaBatteriesService.policyDeclarations(organizationId))
        .batteries,
    ).toEqual([
      expect.objectContaining({ name: "tagger", status: "unavailable" }),
    ]);
  });
});

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
 * A root that includes the batteries and points the `acme` namespace at
 * `targets`; with no target it declares no alias. Its one rule routes every
 * tool to `route`, the root's own `noop` annotator unless named.
 */
function root(
  entry: string | string[],
  targets: string[],
  { route = "noop" }: { route?: string } = {},
): string {
  const included = (Array.isArray(entry) ? entry : [entry])
    .map((spelling) => `"${spelling}"`)
    .join(", ");
  const aliases =
    targets.length === 0
      ? ""
      : `[server_aliases]
acme = [${targets.map((target) => `"${target}"`).join(", ")}]

`;
  return `include = [${included}]

${aliases}[policy]
version = 2

[[policy.annotator]]
name = "noop"

[[policy.tool]]
name = "*"
annotator = "${route}"

[externals.annotators.noop]
url = "http://127.0.0.1:9000/api/guardrails-policy/annotators/noop"
`;
}

/**
 * A battery governing one MCP tool whose single annotator is served by one
 * helper command and needs no credential, so it is active as soon as it is
 * bound to a server.
 */
async function uploadAcme(params: {
  organizationId: string;
  userId: string;
  /** Leaves the helper's annotator undeclared, which no composition accepts. */
  broken?: boolean;
  /** Tells one uploaded version of the battery from another. */
  note?: string;
}) {
  const declaration = params.broken
    ? ""
    : `[[policy.annotator]]
name = "acme.check"

`;
  return openappaBatteriesService.uploadPackage({
    userId: params.userId,
    organizationId: params.organizationId,
    name: "acme",
    files: [
      { path: "appa-package.toml", text: BATTERY_MANIFEST },
      {
        path: "appa.toml",
        text: `[policy]
version = 2

${declaration}[[policy.tool]]
name = "mcp/acme/list"
delta = {}

[externals.annotators."acme.check"]
command = ["python3", "check.py"]
`,
      },
      {
        path: "check.py",
        text: `print('{}')\n${params.note ? `# ${params.note}\n` : ""}`,
      },
    ],
  });
}

/** A battery declaring one annotator and no tool rule, served by one helper command. */
async function uploadTagger(params: {
  organizationId: string;
  userId: string;
}) {
  return openappaBatteriesService.uploadPackage({
    userId: params.userId,
    organizationId: params.organizationId,
    name: "tagger",
    files: [
      {
        path: "appa-package.toml",
        text: `schema = 1
name = "tagger"
description = "Tags every call"

[battery]
policy = "appa.toml"
hosts = ["claude-code"]
helpers = ["tag.py"]
`,
      },
      {
        path: "appa.toml",
        text: `[policy]
version = 2

[[policy.annotator]]
name = "tagger.call"
ranks = ["suspicious", "trusted"]
audiences = ["self"]
marks = []

[externals.annotators."tagger.call"]
command = ["python3", "tag.py"]
`,
      },
      { path: "tag.py", text: "print('{}')\n" },
    ],
  });
}

/** A stored version of `name` whose bytes inspect to nothing, newer than the rest. */
async function storeUnreadable(params: {
  organizationId: string;
  name: string;
}) {
  const files = [
    { path: "appa-package.toml", text: "schema = 1\nname = " },
    { path: "appa.toml", text: "[policy]\nversion = 2\n" },
  ];
  const contentHash = packageContentHash(files);
  await OpenAppaBatteryPackageModel.insert({
    organizationId: params.organizationId,
    name: params.name,
    description: "Bytes that stopped inspecting",
    contentHash,
    files,
  });
  await db
    .update(schema.openappaBatteryPackagesTable)
    .set({ createdAt: new Date(Date.now() + 60_000) })
    .where(
      and(
        eq(
          schema.openappaBatteryPackagesTable.organizationId,
          params.organizationId,
        ),
        eq(schema.openappaBatteryPackagesTable.contentHash, contentHash),
      ),
    );
  return contentHash;
}

/** Save a root revision and recompose from it. */
async function declare(params: {
  organizationId: string;
  userId: string;
  content: string;
  checked?: boolean;
}) {
  const { organizationId, userId, content } = params;
  const latest = await guardrailsPolicyService.get(organizationId);
  if (params.checked === false) {
    await GuardrailsPolicyModel.save({
      organizationId,
      updatedBy: userId,
      content,
      contentHash: createHash("sha256").update(content).digest("hex"),
      expectedRevision: latest.revision,
    });
  } else {
    await guardrailsPolicyService.update({
      organizationId,
      userId,
      content,
      expectedRevision: latest.revision,
    });
  }
  await openappaBatteriesService.recompile(organizationId);
}
