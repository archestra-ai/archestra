import { createHash } from "node:crypto";
import { ADMIN_ROLE_NAME, ARCHESTRA_MCP_CATALOG_ID } from "@archestra/shared";
import { and, eq } from "drizzle-orm";
import config from "@/config";
import db, { schema } from "@/database";
import GuardrailsPolicyModel from "@/models/guardrails-policy";
import OpenAppaBatteryInstallModel from "@/models/openappa-battery-install";
import OpenAppaBatteryPackageModel from "@/models/openappa-battery-package";
import OpenAppaEffectivePolicyModel from "@/models/openappa-effective-policy";
import RuntimeCredentialConnectionModel from "@/models/runtime-credential-connection";
import ToolModel from "@/models/tool";
import {
  deleteRuntimeCredentialConnection,
  deleteRuntimeCredentialDefinition,
  updateRuntimeCredentialDefinition,
} from "@/services/agent-runtime/runtime-credentials";
import { guardrailsPolicyService } from "@/services/guardrails-policy";
import { afterEach, beforeEach, describe, expect, test } from "@/test";
import { bindOrganizationCredential } from "@/test/openappa-credentials";
import {
  createGithubApp,
  deployGithubWithRoster,
  GITHUB_ROSTER_ROOT,
  storedHostMembers,
} from "@/test/openappa-github-roster";
import { type GitHubUserId, GitHubUserIdSchema } from "@/types";
import { openappaBatteriesService } from "./batteries";
import {
  helperUrlBase,
  openappaDeclarations,
  packageContentHash,
} from "./declarations";
import { parsePolicyToml } from "./policy-text";
import { openappaRemediesService } from "./remedies";
import { recompileAllOnStart } from "./service";
import { openappaTrustAudienceService } from "./trust-audience";

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
    const input = (battery: (typeof bundled)[number]) => ({
      entry: `batteries/${battery.name}/appa.toml`,
      name: battery.name,
      policy: battery.base,
      helpers:
        battery.externals.length > 0
          ? { urlBase: "http://127.0.0.1:9000/helpers/install", tokenEnv }
          : undefined,
    });
    const shipped = bundled.filter((battery) => battery.name === "archestra");
    expect(shipped).toHaveLength(1);
    for (const battery of bundled) {
      const edited = await native.editOpenappaPolicy(
        root.content,
        shipped.includes(battery)
          ? []
          : [
              { kind: "addInclude", entry: input(battery).entry },
              ...battery.namespaces.map((namespace) => ({
                kind: "bindServers",
                namespace,
                servers: [`${namespace.replaceAll("-", "_")}_prod`],
              })),
            ],
      );
      expect(edited.errors, battery.name).toEqual([]);
      const composed = await native.composeOpenappaPolicy({
        root: edited.content ?? "",
        batteries: [...new Set([...shipped, battery])].map(input),
      });
      expect(composed.errors, battery.name).toEqual([]);
    }
  });
});

describe("composing an organization's declarations", () => {
  beforeEach(() => {
    config.openappa.enabled = true;
  });

  test("the shipped default governs the built-in tools with the archestra battery", async ({
    makeOrganization,
  }) => {
    const organizationId = (await makeOrganization()).id;
    await ToolModel.seedArchestraTools(ARCHESTRA_MCP_CATALOG_ID);

    const effective =
      await openappaBatteriesService.getEffectivePolicy(organizationId);

    expect(effective.lastError).toBeNull();
    expect(
      (await OpenAppaBatteryInstallModel.list(organizationId)).map(
        ({ batteryName, catalogId, status }) => ({
          batteryName,
          catalogId,
          status,
        }),
      ),
    ).toEqual([
      {
        batteryName: "archestra",
        catalogId: ARCHESTRA_MCP_CATALOG_ID,
        status: "active",
      },
    ]);
  });

  test("recompiles a cached revision-zero policy when the shipped default changes", async ({
    makeOrganization,
  }) => {
    const organizationId = (await makeOrganization()).id;
    await ToolModel.seedArchestraTools(ARCHESTRA_MCP_CATALOG_ID);
    const initial =
      await openappaBatteriesService.getEffectivePolicy(organizationId);
    const oldContent = "[policy]\nversion = 2\n";
    await OpenAppaEffectivePolicyModel.save({
      organizationId,
      now: new Date(),
      expected: initial,
      values: {
        content: oldContent,
        contentHash: createHash("sha256").update(oldContent).digest("hex"),
        rootRevision: 0,
        installFingerprint: "cached-before-default-update",
        error: null,
        served: null,
        retainedAnnotators: null,
      },
    });

    const refreshed =
      await openappaBatteriesService.getEffectivePolicy(organizationId);
    const root = await guardrailsPolicyService.get(organizationId);
    expect(refreshed.content).toContain("context_control = true");
    expect(refreshed.installFingerprint).toMatch(
      new RegExp(`:${root.contentHash}$`),
    );
  });

  test("refreshes legacy effective policy limits without changing an authored cap", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const userId = (await makeUser()).id;
    for (const limit of [undefined, 4096]) {
      const organizationId = (await makeOrganization()).id;
      await makeMember(userId, organizationId, { role: ADMIN_ROLE_NAME });
      const content =
        "[policy]\nversion = 2\n" +
        (limit === undefined ? "" : `[externals]\nmax_body_bytes = ${limit}\n`);
      await declare({ organizationId, userId, content });
      const initial =
        await openappaBatteriesService.getEffectivePolicy(organizationId);
      const legacyContent =
        limit === undefined
          ? `${content}[externals]\nmax_body_bytes = 65536\n`
          : content;
      await OpenAppaEffectivePolicyModel.save({
        organizationId,
        now: new Date(),
        expected: initial,
        values: {
          content: legacyContent,
          contentHash: createHash("sha256").update(legacyContent).digest("hex"),
          rootRevision: initial.rootRevision,
          installFingerprint: initial.installFingerprint.replace(/^v\d+:/, ""),
          error: null,
          served: null,
          retainedAnnotators: null,
        },
      });

      const refreshed =
        await openappaBatteriesService.getEffectivePolicy(organizationId);
      expect(refreshed.lastError).toBeNull();
      if (limit === undefined)
        expect(refreshed.content).not.toContain("max_body_bytes");
      else expect(refreshed.content).toContain(`max_body_bytes = ${limit}`);
      expect(await openappaBatteriesService.recompile(organizationId)).toEqual(
        refreshed,
      );
    }
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

describe("routing to an organization-wide battery", () => {
  beforeEach(() => {
    config.openappa.enabled = true;
  });

  test("a rule counts only from a battery that composes it", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const userId = (await makeUser()).id;
    await makeMember(userId, organizationId, { role: ADMIN_ROLE_NAME });
    const tagger = await uploadTagger({ organizationId, userId });
    const router = await uploadRouter({ organizationId, userId });
    const statuses = async () =>
      Object.fromEntries(
        (
          await openappaBatteriesService.policyDeclarations(organizationId)
        ).batteries.map((battery) => [battery.name, battery.status]),
      );

    // No alias binds the router, so it is stubbed and its rule routes nothing.
    await declare({
      organizationId,
      userId,
      content: root([tagger.entry, router.entry], []),
    });
    expect(await statuses()).toEqual({
      tagger: "unrouted",
      acme: "server_missing",
    });

    // Bound to a server, the router composes and its rule routes to tagger.
    const catalog = await makeInternalMcpCatalog({ organizationId });
    await makeTool({
      catalogId: catalog.id,
      name: "acme_prod__list",
      rawName: "list",
    });
    await declare({
      organizationId,
      userId,
      content: root([tagger.entry, router.entry], ["acme_prod"]),
    });
    expect(await statuses()).toEqual({ tagger: "active", acme: "active" });
    expect(
      (await OpenAppaEffectivePolicyModel.find(organizationId))?.lastError,
    ).toBeNull();
  });
});

describe("validating against this deployment", () => {
  beforeEach(() => {
    config.openappa.enabled = true;
  });
  const MINIMAL = "[policy]\nversion = 2\n";

  test("a starter whose archestra battery has no catalog here is refused when it is new, and warned about when it is the current revision", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const userId = (await makeUser()).id;
    await makeMember(userId, organizationId, { role: ADMIN_ROLE_NAME });
    const starter = (await guardrailsPolicyService.get(organizationId)).content;

    // On its own the starter composes: the archestra battery declares the
    // audience source its `internal` audience reads.
    const resolution = await openappaDeclarations.resolve({
      organizationId,
      content: starter,
    });
    const standalone = await openappaDeclarations.composeForCheck({
      root: starter,
      resolution,
      deployed: await openappaBatteriesService.deployedBatteries({
        organizationId,
        resolution,
      }),
    });
    expect(standalone.errors).toEqual([]);

    // As the current revision it refuses nothing new, so it stays writable,
    // and the refusal the runtime meets is reported as it meets it.
    const current = await guardrailsPolicyService.validate(starter, {
      organizationId,
    });
    expect(current.valid).toBe(true);
    expect(current.errors).toEqual([]);
    const effective =
      await openappaBatteriesService.getEffectivePolicy(organizationId);
    const refusal = effective.lastError?.split("\n") ?? [];
    expect(refusal).toHaveLength(2);
    expect(current.warnings).toHaveLength(refusal.length);

    // Replacing a revision this deployment composes, preview and save refuse it.
    const saved = await guardrailsPolicyService.update({
      organizationId,
      userId,
      content: MINIMAL,
      expectedRevision: 0,
    });
    const replacing = await guardrailsPolicyService.validate(starter, {
      organizationId,
    });
    expect(replacing.valid).toBe(false);
    expect(replacing.errors).toHaveLength(refusal.length);
    await expect(
      guardrailsPolicyService.update({
        organizationId,
        userId,
        content: starter,
        expectedRevision: saved.revision,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  test("seeding the catalog the held-back battery names lets the starter compose", async ({
    makeOrganization,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const starter = (await guardrailsPolicyService.get(organizationId)).content;
    await openappaBatteriesService.getEffectivePolicy(organizationId);

    await ToolModel.seedArchestraTools(ARCHESTRA_MCP_CATALOG_ID);

    expect(
      await guardrailsPolicyService.validate(starter, {
        organizationId,
        previous: MINIMAL,
      }),
    ).toEqual({ valid: true, errors: [], warnings: [] });
    expect(
      (await openappaBatteriesService.recompile(organizationId)).lastError,
    ).toBeNull();
  });

  test("a draft that declares a battery for a server not installed yet stays valid", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const userId = (await makeUser()).id;
    await makeMember(userId, organizationId, { role: ADMIN_ROLE_NAME });
    const acme = await uploadAcme({ organizationId, userId });

    const draft = await guardrailsPolicyService.validate(
      root([acme.entry], ["acme_prod"]),
      { organizationId, previous: MINIMAL },
    );
    expect(draft).toEqual({ valid: true, errors: [], warnings: [] });
  });

  test("a draft that keeps the current revision's refusal and adds an unrelated not-yet-served battery stays valid", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const userId = (await makeUser()).id;
    await makeMember(userId, organizationId, { role: ADMIN_ROLE_NAME });
    const acme = await uploadAcme({ organizationId, userId });
    const starter = (await guardrailsPolicyService.get(organizationId)).content;
    const native = await import("@archestra/openappa-rs");
    const edited = await native.editOpenappaPolicy(starter, [
      { kind: "addInclude", entry: acme.entry },
      { kind: "bindServers", namespace: "acme", servers: ["acme_prod"] },
    ]);
    expect(edited.errors).toEqual([]);

    const current = await guardrailsPolicyService.validate(starter, {
      organizationId,
    });
    const draft = await guardrailsPolicyService.validate(edited.content ?? "", {
      organizationId,
    });
    expect(draft.valid).toBe(true);
    expect(draft.errors).toEqual([]);
    expect(draft.warnings).toHaveLength(current.warnings.length + 1);
  });
});

describe("a battery with targets", () => {
  const sandbox = config.daggerRuntime.enabled;
  beforeEach(() => {
    config.openappa.enabled = true;
  });
  afterEach(() => {
    config.daggerRuntime.enabled = sandbox;
  });

  test("waits for its multi-user credentials, then deploys that target only while the sandbox runs", async ({
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
    config.daggerRuntime.enabled = true;
    const { entry } = await uploadTargetedAcme({ organizationId, userId });
    await declare({
      organizationId,
      userId,
      content: root(entry, ["acme_prod"]),
    });
    const acme = async () => {
      const { batteries } =
        await openappaBatteriesService.policyDeclarations(organizationId);
      const policy = await openappaBatteriesService.recompile(organizationId);
      expect(policy.lastError).toBeNull();
      const composed = parsePolicyToml(policy.content)?.policy as
        | {
            annotator?: Array<{ name: string }>;
            tool?: Array<{ requires?: { attention?: string[] } }>;
          }
        | undefined;
      const annotators = composed?.annotator?.map(
        (annotator) => annotator.name,
      );
      return {
        status: batteries.find((battery) => battery.name === "acme")?.status,
        deploysTarget: annotators?.includes("acme.visibility") ?? false,
        composesBaseRule:
          composed?.tool?.some((tool) =>
            tool.requires?.attention?.includes("acme-review"),
          ) ?? false,
      };
    };
    // Only the target's credential is unbound: its base still composes.
    expect(await acme()).toEqual({
      status: "missing_credentials",
      deploysTarget: false,
      composesBaseRule: true,
    });

    await bindOrganizationCredential({
      organizationId,
      userId,
      variable: ACME_TOKEN,
      key: "acme-token",
    });
    expect(await acme()).toEqual({
      status: "active",
      deploysTarget: true,
      // Still composed after the target, whose rule matches first.
      composesBaseRule: true,
    });

    config.daggerRuntime.enabled = false;
    expect(await acme()).toEqual({
      status: "active",
      deploysTarget: false,
      composesBaseRule: true,
    });
  });

  test("the remedies and audience views read a deployed target's rule in place of the base rule it shadows", async ({
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
    config.daggerRuntime.enabled = true;
    const { entry } = await uploadTargetedAcme({ organizationId, userId });
    await declare({
      organizationId,
      userId,
      content: root(entry, ["acme_prod"]),
    });
    await bindOrganizationCredential({
      organizationId,
      userId,
      variable: ACME_TOKEN,
      key: "acme-token",
    });
    const views = async () => {
      const remedies = await openappaRemediesService.view({
        organizationId,
        userId,
      });
      const audience = await openappaTrustAudienceService.view({
        organizationId,
        userId,
      });
      return {
        blocks: remedies.blocks
          .filter((block) => block.kind === "approvals")
          .map((block) => ({
            kind: block.kind,
            unservedMarks: block.unservedMarks,
          })),
        self: audience.audiences.find((level) => level.name === "self")?.kind,
      };
    };
    expect(await views()).toEqual({ blocks: [], self: "builtin" });

    config.daggerRuntime.enabled = false;
    expect(await views()).toEqual({
      blocks: [{ kind: "approvals", unservedMarks: ["acme-review"] }],
      self: "unmapped",
    });
  });

  test("a battery whose annotator only its target declares governs the organization", async ({
    makeOrganization,
    makeUser,
    makeMember,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const userId = (await makeUser()).id;
    await makeMember(userId, organizationId, { role: ADMIN_ROLE_NAME });
    config.daggerRuntime.enabled = true;
    const { entry } = await uploadTargetedNotary({ organizationId, userId });
    await bindOrganizationCredential({
      organizationId,
      userId,
      variable: NOTARY_TOKEN,
      key: "notary-token",
    });
    await declare({
      organizationId,
      userId,
      content: root(entry, [], { route: "notary.check" }),
    });

    const policy = await openappaBatteriesService.recompile(organizationId);
    expect(policy.lastError).toBeNull();
    const composed = parsePolicyToml(policy.content)?.policy as
      | { annotator?: Array<{ name: string }> }
      | undefined;
    expect(composed?.annotator?.map(({ name }) => name)).toContain(
      "notary.check",
    );
    const { batteries } =
      await openappaBatteriesService.policyDeclarations(organizationId);
    expect(batteries.find(({ name }) => name === "notary")).toMatchObject({
      scope: "organization",
      status: "active",
    });
    expect(
      (await OpenAppaBatteryInstallModel.list(organizationId)).map(
        ({ batteryName, catalogId, target }) => ({
          batteryName,
          catalogId,
          target,
        }),
      ),
    ).toEqual([
      { batteryName: "notary", catalogId: null, target: "multi-user" },
    ]);
  });

  test("a deployed target's member roster is declared by the host until the root declares its own", async ({
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
      name: "GitHub prod",
    });
    await makeTool({
      catalogId: catalog.id,
      name: "github_prod__get_issue",
      rawName: "get_issue",
    });
    config.daggerRuntime.enabled = true;
    const content = `include = ["batteries/github/appa.toml"]

[server_aliases]
github = ["github_prod"]

[policy]
version = 2
`;
    await declare({ organizationId, userId, content });
    const roster = async () => {
      const policy = await openappaBatteriesService.recompile(organizationId);
      expect(policy.lastError).toBeNull();
      const externals = parsePolicyToml(policy.content)?.externals as
        | { audience?: Record<string, { readers?: unknown }> }
        | undefined;
      return externals?.audience?.["host-members"]?.readers;
    };
    // Held back for its token, github composes nothing that looks a member up.
    expect(await roster()).toBeUndefined();

    await bindOrganizationCredential({
      organizationId,
      userId,
      variable: "APPA_PROVIDER_GITHUB_TOKEN",
      key: "github-token",
    });
    expect(await roster()).toEqual({});

    await declare({
      organizationId,
      userId,
      content: `${content}
[externals.audience.host-members]
readers = { "github:1" = "ana@corp.example" }
`,
    });
    expect(await roster()).toEqual({ "github:1": "ana@corp.example" });
  });
});

describe("the host member roster", () => {
  const sandbox = config.daggerRuntime.enabled;
  afterEach(() => {
    config.daggerRuntime.enabled = sandbox;
  });

  const ANA = GitHubUserIdSchema.parse(1001);
  const BOB = GitHubUserIdSchema.parse(1002);

  const setUp = async (fixtures: {
    makeOrganization: () => Promise<{ id: string }>;
    makeUser: (overrides?: { email?: string }) => Promise<{ id: string }>;
    makeMember: (
      userId: string,
      organizationId: string,
      overrides?: { role?: string },
    ) => Promise<unknown>;
    makeInternalMcpCatalog: (overrides: {
      organizationId: string;
      name: string;
    }) => Promise<{ id: string }>;
    makeTool: (overrides: {
      catalogId: string;
      name: string;
      rawName: string;
    }) => Promise<unknown>;
  }) => {
    const organizationId = (await fixtures.makeOrganization()).id;
    const userId = (await fixtures.makeUser()).id;
    await fixtures.makeMember(userId, organizationId, {
      role: ADMIN_ROLE_NAME,
    });
    await deployGithubWithRoster({ organizationId, userId, ...fixtures });
    const member = async (email: string, githubId: GitHubUserId) => {
      const user = await fixtures.makeUser({ email });
      await fixtures.makeMember(user.id, organizationId);
      await RuntimeCredentialConnectionModel.upsert({
        organizationId,
        scope: "personal",
        userId: user.id,
        credentialId: "github-user",
        value: "token",
        githubId,
      });
      return user.id;
    };
    return { organizationId, userId, member };
  };

  test("names each connected member by their GitHub account, leaving out an account two members share", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const { organizationId, member } = await setUp({
      makeOrganization,
      makeUser,
      makeMember,
      makeInternalMcpCatalog,
      makeTool,
    });
    await member("ana@corp.example", ANA);
    await member("mallory@corp.example", ANA);
    await member("bob@corp.example", BOB);

    const first = await openappaBatteriesService.recompile(organizationId);
    expect(first.lastError).toBeNull();
    expect(await storedHostMembers(organizationId)).toEqual({
      [`github:${BOB}`]: "bob@corp.example",
    });
    // The same roster composes the same bytes.
    const again = await openappaBatteriesService.recompile(organizationId);
    expect(again.content).toBe(first.content);
    expect(again.installFingerprint).toBe(first.installFingerprint);
  });

  test("a roster change alone moves the fingerprint", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const { organizationId, member } = await setUp({
      makeOrganization,
      makeUser,
      makeMember,
      makeInternalMcpCatalog,
      makeTool,
    });
    const before = await openappaBatteriesService.recompile(organizationId);
    await member("ana@corp.example", ANA);
    const after = await openappaBatteriesService.recompile(organizationId);
    expect(after.installFingerprint).not.toBe(before.installFingerprint);
    expect(await storedHostMembers(organizationId)).toEqual({
      [`github:${ANA}`]: "ana@corp.example",
    });
  });

  test("a roster the root declares is the root's", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const { organizationId, userId, member } = await setUp({
      makeOrganization,
      makeUser,
      makeMember,
      makeInternalMcpCatalog,
      makeTool,
    });
    await member("ana@corp.example", ANA);
    await declare({
      organizationId,
      userId,
      content: `${GITHUB_ROSTER_ROOT}
[externals.audience.host-members]
readers = { "github:7" = "zoe@corp.example" }
`,
    });
    expect(await storedHostMembers(organizationId)).toEqual({
      "github:7": "zoe@corp.example",
    });
  });

  test("knows nobody while GitHub's token is bound to an App on another GitHub", async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const { organizationId, userId, member } = await setUp({
      makeOrganization,
      makeUser,
      makeMember,
      makeInternalMcpCatalog,
      makeTool,
    });
    await member("ana@corp.example", ANA);
    await createGithubApp({
      organizationId,
      userId,
      key: "enterprise-app",
      githubUrl: "https://github.example.com/api/v3",
    });
    await openappaBatteriesService.setCredentialBinding({
      userId,
      organizationId,
      variable: "APPA_PROVIDER_GITHUB_TOKEN",
      key: "enterprise-app",
    });
    expect(await storedHostMembers(organizationId)).toEqual({});
  });

  describe("follows", () => {
    test("a disconnect", async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeInternalMcpCatalog,
      makeTool,
    }) => {
      const { organizationId, member } = await setUp({
        makeOrganization,
        makeUser,
        makeMember,
        makeInternalMcpCatalog,
        makeTool,
      });
      const ana = await member("ana@corp.example", ANA);
      await member("bob@corp.example", BOB);
      await openappaBatteriesService.recompile(organizationId);

      await deleteRuntimeCredentialConnection({
        organizationId,
        userId: ana,
        credentialId: "github-user",
        scope: "personal",
      });
      expect(await storedHostMembers(organizationId)).toEqual({
        [`github:${BOB}`]: "bob@corp.example",
      });
    });

    test("deleting the definition members connect through", async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeInternalMcpCatalog,
      makeTool,
    }) => {
      const { organizationId, member } = await setUp({
        makeOrganization,
        makeUser,
        makeMember,
        makeInternalMcpCatalog,
        makeTool,
      });
      await member("ana@corp.example", ANA);
      await openappaBatteriesService.recompile(organizationId);

      await deleteRuntimeCredentialDefinition({
        organizationId,
        key: "github-user",
      });
      expect(await storedHostMembers(organizationId)).toEqual({});
    });

    test("pointing the GitHub App at another GitHub", async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeInternalMcpCatalog,
      makeTool,
    }) => {
      const { organizationId, member } = await setUp({
        makeOrganization,
        makeUser,
        makeMember,
        makeInternalMcpCatalog,
        makeTool,
      });
      await member("ana@corp.example", ANA);
      await openappaBatteriesService.recompile(organizationId);

      await updateRuntimeCredentialDefinition({
        organizationId,
        key: "repository-app",
        definition: { githubUrl: "https://github.example.com/api/v3" },
      });
      expect(await storedHostMembers(organizationId)).toEqual({});
    });

    test("a start that finds a composition an earlier build stored", async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeInternalMcpCatalog,
      makeTool,
    }) => {
      const { organizationId, member } = await setUp({
        makeOrganization,
        makeUser,
        makeMember,
        makeInternalMcpCatalog,
        makeTool,
      });
      // Connected before the roster was composed: the stored row predates it.
      await member("ana@corp.example", ANA);
      expect(await storedHostMembers(organizationId)).toEqual({});

      await recompileAllOnStart();
      expect(await storedHostMembers(organizationId)).toEqual({
        [`github:${ANA}`]: "ana@corp.example",
      });
    });
  });
});

const ACME_TOKEN = "APPA_PROVIDER_ACME_TOKEN";
const NOTARY_TOKEN = "APPA_PROVIDER_NOTARY_TOKEN";

/** A battery with an empty base whose multi-user target declares one credentialed annotator. */
async function uploadTargetedNotary(params: {
  organizationId: string;
  userId: string;
}) {
  const empty = "[policy]\nversion = 2\n";
  return openappaBatteriesService.uploadPackage({
    userId: params.userId,
    organizationId: params.organizationId,
    name: "notary",
    files: [
      {
        path: "appa-package.toml",
        text: `schema = 1
name = "notary"
description = "Checks every call"

[battery]
policy = "appa.toml"
hosts = ["claude-code"]
helpers = ["check.py"]

[battery.targets.single-user]
policy = "single-user.toml"

[battery.targets.multi-user]
policy = "multi-user.toml"
`,
      },
      { path: "appa.toml", text: empty },
      { path: "single-user.toml", text: empty },
      {
        path: "multi-user.toml",
        text: `${empty}
[[policy.annotator]]
name = "notary.check"
ranks = ["suspicious", "trusted"]
audiences = ["self"]
marks = []

[externals.annotators."notary.check"]
command = ["python3", "check.py"]
token_env = "${NOTARY_TOKEN}"
`,
      },
      { path: "check.py", text: "print('{}')\n" },
    ],
  });
}

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

/** The acme battery with targets: its multi-user target routes to a credentialed helper. */
async function uploadTargetedAcme(params: {
  organizationId: string;
  userId: string;
}) {
  const empty = "[policy]\nversion = 2\n";
  return openappaBatteriesService.uploadPackage({
    userId: params.userId,
    organizationId: params.organizationId,
    name: "acme",
    files: [
      {
        path: "appa-package.toml",
        text: `${BATTERY_MANIFEST}
[battery.targets.single-user]
policy = "single-user.toml"

[battery.targets.multi-user]
policy = "multi-user.toml"
`,
      },
      {
        path: "appa.toml",
        text: `${empty}
[[policy.tool]]
name = "mcp/acme/list"
requires = { attention = ["acme-review"], audience = { contains = ["self"] } }
`,
      },
      { path: "single-user.toml", text: empty },
      {
        path: "multi-user.toml",
        text: `${empty}
[[policy.annotator]]
name = "acme.visibility"
ranks = ["suspicious", "trusted"]
audiences = ["self"]
marks = []

[[policy.tool]]
name = "mcp/acme/get"
annotator = "acme.visibility"

[[policy.tool]]
name = "mcp/acme/list"
delta = {}

[externals.annotators."acme.visibility"]
command = ["python3", "check.py"]
token_env = "${ACME_TOKEN}"
`,
      },
      { path: "check.py", text: "print('{}')\n" },
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

/** A battery governing `mcp/acme/list` whose one rule routes to tagger's annotator. */
async function uploadRouter(params: {
  organizationId: string;
  userId: string;
}) {
  return openappaBatteriesService.uploadPackage({
    userId: params.userId,
    organizationId: params.organizationId,
    name: "acme",
    files: [
      {
        path: "appa-package.toml",
        text: BATTERY_MANIFEST.replace('helpers = ["check.py"]\n', ""),
      },
      {
        path: "appa.toml",
        text: `[policy]
version = 2

[[policy.tool]]
name = "mcp/acme/list"
annotator = "tagger.call"
`,
      },
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
