import { createHash } from "node:crypto";
import { ADMIN_ROLE_NAME } from "@archestra/shared";
import { afterEach, vi } from "vitest";
import config from "@/config";
import logger from "@/logging";
import GuardrailsPolicyModel from "@/models/guardrails-policy";
import OpenAppaBatteryInstallModel from "@/models/openappa-battery-install";
import OpenAppaEffectivePolicyModel from "@/models/openappa-effective-policy";
import { sandboxRuntimeService } from "@/sandbox-runtime/sandbox-runtime-service";
import { guardrailsPolicyService } from "@/services/guardrails-policy";
import { beforeEach, describe, expect, test } from "@/test";
import { openappaBatteriesService } from "./batteries";
import { openappaCoverageService } from "./coverage";
import { openappaHelperBridge } from "./helper-bridge";
import { chatOpenAppaSession, endTurn } from "./service";

vi.mock("@/logging");

describe("what a refused composition keeps serving", () => {
  let organizationId: string;
  let userId: string;
  let catalogId: string;

  beforeEach(
    async ({
      makeOrganization,
      makeUser,
      makeMember,
      makeInternalMcpCatalog,
      makeTool,
    }) => {
      config.openappa.enabled = true;
      organizationId = (await makeOrganization()).id;
      userId = (await makeUser()).id;
      await makeMember(userId, organizationId, { role: ADMIN_ROLE_NAME });
      const catalog = await makeInternalMcpCatalog({
        organizationId,
        name: "Acme prod",
      });
      catalogId = catalog.id;
      await makeTool({
        catalogId: catalog.id,
        name: "acme_prod__list",
        rawName: "list",
      });
    },
  );

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("an accepted composition records the revision, time and batteries it serves", async () => {
    const { entry, contentHash } = await uploadAcme({ note: "served" });
    await declare(root(entry));

    const policy = await OpenAppaEffectivePolicyModel.find(organizationId);
    const [install] = await OpenAppaBatteryInstallModel.list(organizationId);
    expect(policy?.lastError).toBeNull();
    expect(policy?.served).toEqual({
      v: 1,
      kind: "composition",
      contentHash: policy?.contentHash,
      rootRevision: policy?.rootRevision,
      composedAt: policy?.compiledAt.toISOString(),
      batteries: [
        {
          entry,
          name: "acme",
          status: "active",
          composed: true,
          packageHash: contentHash,
          target: null,
          installId: install.id,
          credentialBindings: {},
        },
      ],
    });
    const view =
      await openappaBatteriesService.effectivePolicyView(organizationId);
    expect(view).not.toHaveProperty("served");
    expect(view.composition).toEqual({
      served: {
        kind: "current",
        rootRevision: policy?.rootRevision,
        composedAt: policy?.compiledAt,
      },
      refusal: null,
    });
  });

  test("a refusal keeps the earlier composition enforced and records the refusal apart from it", async () => {
    const served = await uploadAcme({ note: "served" });
    // Uploaded before anything includes acme, so it pins nothing yet.
    const newer = await uploadAcme({ note: "refused" });
    await declare(root(served.entry));
    const clean = await OpenAppaEffectivePolicyModel.find(organizationId);
    const warn = vi.mocked(logger.warn);
    warn.mockClear();

    // The next revision includes the newer acme and a rule the runtime refuses.
    await declare(refusing(newer.entry), { checked: false });
    const refused = await OpenAppaEffectivePolicyModel.find(organizationId);
    expect(refused?.lastError).toBeTruthy();
    expect(refused?.content).toBe(clean?.content);
    expect(refused?.served).toEqual(clean?.served);
    expect(
      warn.mock.calls.filter(
        ([, message]) =>
          message ===
          "OpenAPPA composition refused; the runtime keeps enforcing an earlier composition",
      ),
    ).toHaveLength(1);

    const declarations =
      await openappaBatteriesService.policyDeclarations(organizationId);
    expect(declarations.composition).toEqual({
      served: {
        kind: "previous",
        rootRevision: clean?.rootRevision,
        composedAt: clean?.compiledAt,
        batteries: [{ name: "acme", status: "active", composed: true }],
      },
      refusal: {
        message: refused?.lastError,
        at: refused?.lastErrorAt,
        rootRevision: (clean?.rootRevision ?? 0) + 1,
      },
    });
    expect(
      declarations.batteries.map(({ name, served }) => ({ name, served })),
    ).toEqual([{ name: "acme", served: { status: "active", composed: true } }]);

    // Its rules still judge tools: coverage counts them enforced, and says
    // which composition it describes.
    const coverage = await openappaCoverageService.summary({
      organizationId,
      visibleCatalogIds: [catalogId],
    });
    expect(coverage.batteries.active).toEqual([{ name: "acme", tools: 1 }]);
    expect(coverage.batteries.broken).toEqual([]);
    expect(coverage.totals.notEnforced).toBe(0);
    expect(coverage.composition).toEqual({
      kind: "previous",
      servedRootRevision: clean?.rootRevision,
      refusedRootRevision: refused?.rootRevision,
      rulesMayDiffer: true,
    });

    // The helpers of the enforced composition run the package it composed,
    // although the install row now names the refused upload.
    vi.spyOn(sandboxRuntimeService, "attach").mockResolvedValue(undefined);
    const run = vi
      .spyOn(sandboxRuntimeService, "runCommand")
      .mockResolvedValue({
        exitCode: 0,
        stdout: "{}",
        stderr: "",
        durationMs: 1,
        timedOut: false,
        truncated: false,
      });
    const [install] = await OpenAppaBatteryInstallModel.list(organizationId);
    expect(install.packageHash).not.toBe(served.contentHash);
    const outcome = await openappaHelperBridge.consult({
      installId: install.id,
      externalName: "acme.check",
      request: JSON.stringify({
        version: 1,
        kind: "annotation",
        annotator: "acme.check",
        arguments: {},
      }),
    });
    expect(outcome.kind).toBe("answered");
    const mounted = JSON.stringify(run.mock.calls[0]?.[0].replayEntries);
    expect(mounted).toContain("# served");
    expect(mounted).not.toContain("# refused");

    // The package that composition uses stays until a revision composes without it.
    await expect(
      openappaBatteriesService.deletePackage({
        organizationId,
        contentHash: served.contentHash,
      }),
    ).rejects.toMatchObject({ statusCode: 409 });

    // A later revision is refused too: the refusal advances, what is served does not.
    const latest = await guardrailsPolicyService.get(organizationId);
    await declare(`${refusing(newer.entry)}\n# once more\n`, {
      checked: false,
    });
    const again =
      await openappaBatteriesService.policyDeclarations(organizationId);
    expect(again.composition.served).toMatchObject({
      kind: "previous",
      rootRevision: clean?.rootRevision,
    });
    expect(again.composition.refusal?.rootRevision).toBe(latest.revision + 1);

    // Once a text composes again, it records itself and the refusal lifts.
    const info = vi.mocked(logger.info);
    info.mockClear();
    await declare(root(newer.entry));
    const reopened = await OpenAppaEffectivePolicyModel.find(organizationId);
    expect(reopened?.lastError).toBeNull();
    expect(reopened?.served).toMatchObject({
      kind: "composition",
      contentHash: reopened?.contentHash,
      rootRevision: latest.revision + 2,
    });
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ organizationId }),
      "OpenAPPA composition opened again",
    );
  });

  test("a refusal with no earlier composition serves the root text alone and refuses governed calls plainly", async () => {
    const { entry } = await uploadAcme({ broken: true });
    const content = root(entry);
    await declare(content, { checked: false });

    const policy = await OpenAppaEffectivePolicyModel.find(organizationId);
    expect(policy?.lastError).toBeTruthy();
    expect(policy?.content).toContain("include = [");
    expect(policy?.served).toEqual({
      v: 1,
      kind: "root_only",
      contentHash: policy?.contentHash,
      rootRevision: policy?.rootRevision,
    });
    expect(
      (await openappaBatteriesService.policyDeclarations(organizationId))
        .composition.served,
    ).toEqual({ kind: "root_only" });

    // A dispatch the runtime refuses says why plainly: nothing ever composed.
    const failure = await endTurn(
      chatOpenAppaSession(organizationId, userId, "root-only"),
      "turn-1",
    ).then(
      () => expect.unreachable("a root text alone was dispatched"),
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({
      statusCode: 500,
      shouldRetry: false,
      message: expect.stringContaining("no earlier composition exists"),
    });
  });

  async function uploadAcme(params: { broken?: boolean; note?: string }) {
    return openappaBatteriesService.uploadPackage({
      userId,
      organizationId,
      name: "acme",
      files: acmeFiles(params),
    });
  }

  /** Save a root revision, through validation or straight to the model, and recompose. */
  async function declare(content: string, options: { checked?: boolean } = {}) {
    const latest = await guardrailsPolicyService.get(organizationId);
    if (options.checked === false)
      await GuardrailsPolicyModel.save({
        organizationId,
        updatedBy: userId,
        content,
        contentHash: createHash("sha256").update(content).digest("hex"),
        expectedRevision: latest.revision,
      });
    else
      await guardrailsPolicyService.update({
        organizationId,
        userId,
        content,
        expectedRevision: latest.revision,
      });
    await openappaBatteriesService.recompile(organizationId);
  }
});

/** The acme battery's files; `broken` leaves its helper's annotator undeclared. */
function acmeFiles(params: { broken?: boolean; note?: string }) {
  const declaration = params.broken
    ? ""
    : `[[policy.annotator]]
name = "acme.check"

`;
  return [
    { path: "appa-package.toml", text: MANIFEST },
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
  ];
}

const MANIFEST = `schema = 1
name = "acme"
description = "Acme battery under test"

[battery]
policy = "appa.toml"
hosts = ["claude-code"]
namespaces = ["acme"]
helpers = ["check.py"]
`;

/** `root(entry)` with a rule naming an annotator nothing declares, which the runtime refuses. */
function refusing(entry: string): string {
  return `${root(entry)}
[[policy.tool]]
name = "mcp/acme/list"
annotator = "nobody.declares"
`;
}

/** A root that includes the battery on the acme_prod server and routes every other tool to a URL annotator. */
function root(entry: string): string {
  return `include = ["${entry}"]

[server_aliases]
acme = ["acme_prod"]

[policy]
version = 2

[[policy.annotator]]
name = "noop"

[[policy.tool]]
name = "*"
annotator = "noop"

[externals.annotators.noop]
url = "http://127.0.0.1:9000/api/guardrails-policy/annotators/noop"
`;
}
