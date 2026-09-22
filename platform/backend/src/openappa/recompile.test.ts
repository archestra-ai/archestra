import { createHash, randomUUID } from "node:crypto";
import { vi } from "vitest";
import config from "@/config";
import GuardrailsPolicyModel from "@/models/guardrails-policy";
import OpenAppaEffectivePolicyModel from "@/models/openappa-effective-policy";
import { guardrailsPolicyService } from "@/services/guardrails-policy";
import { beforeEach, describe, expect, test } from "@/test";
import { ApiError } from "@/types";
import { openappaBatteriesService } from "./batteries";

const native = vi.hoisted(() => {
  let release: (() => void) | null = null;
  const stall = { next: null as Promise<void> | null };
  const composed: string[][] = [];
  const failures = { next: false };
  const refusals = { next: false };
  /** Runs inside every composition, after its inputs were read: lets a test
   * land a competing store while the recomposition is mid-flight. */
  const contend = { each: null as (() => Promise<void>) | null };
  return {
    composed,
    failures,
    refusals,
    contend,
    /** The next composition reads its inputs, then waits until released. */
    stallNext: () => {
      stall.next = new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    release: () => release?.(),
    listBundledOpenappaBatteries: vi.fn(async () => [
      {
        name: "acme",
        description: "",
        namespaces: ["acme"],
        policy: "[policy]\nversion = 2\n",
        helpers: [],
        credentials: [],
        externals: [],
        files: [],
      },
    ]),
    composeOpenappaPolicy: vi.fn(
      async (input: { root: string; batteries: Array<{ name: string }> }) => {
        composed.push(input.batteries.map((battery) => battery.name));
        if (failures.next) {
          failures.next = false;
          throw new Error("the runtime crashed while composing");
        }
        await contend.each?.();
        const wait = stall.next;
        stall.next = null;
        if (wait) await wait;
        if (refusals.next) {
          refusals.next = false;
          return {
            content: null,
            errors: ["the runtime refused the composed policy"],
          };
        }
        return { content: input.root, errors: [] };
      },
    ),
  };
});
// The composition is the one thing these tests drive: reading and editing the
// declarations stay the real thing, so the root text under test is real too.
vi.mock("@archestra/openappa-rs", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  ...native,
}));

describe("recompile coalescing", () => {
  beforeEach(() => {
    config.openappa.enabled = true;
    native.composed.length = 0;
    native.contend.each = null;
    native.refusals.next = false;
  });

  test("a caller never joins a composition that started before its write", async ({
    makeOrganization,
    makeUser,
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const userId = (await makeUser()).id;
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Acme",
    });
    await makeTool({
      catalogId: catalog.id,
      name: "acme__ping",
      rawName: "ping",
    });

    // The stale composition reads its inputs, then stalls so a write can
    // land while it is in flight.
    native.stallNext();
    const stale = openappaBatteriesService.recompile(organizationId);
    await vi.waitFor(() => expect(native.composed).toHaveLength(1));
    await declare({ organizationId, userId });
    const afterWrite = openappaBatteriesService.recompile(organizationId);
    const alsoAfterWrite = openappaBatteriesService.recompile(organizationId);
    native.release();

    const [first, second, third] = await Promise.all([
      stale,
      afterWrite,
      alsoAfterWrite,
    ]);
    expect(native.composed).toEqual([[], ["acme"]]);
    expect(second.installFingerprint).not.toBe(first.installFingerprint);
    expect(third.installFingerprint).toBe(second.installFingerprint);
    expect(
      await OpenAppaEffectivePolicyModel.find(organizationId),
    ).toMatchObject({ installFingerprint: second.installFingerprint });
  });

  test("a failed recompose leaves a row the next read recomposes instead of serving", async ({
    makeOrganization,
    makeUser,
    makeInternalMcpCatalog,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const userId = (await makeUser()).id;
    const stored = await openappaBatteriesService.recompile(organizationId);
    await makeInternalMcpCatalog({ organizationId, name: "Acme" });
    await declare({ organizationId, userId });
    native.failures.next = true;
    await expect(
      openappaBatteriesService.recompile(organizationId),
    ).rejects.toThrow();
    expect(
      (await OpenAppaEffectivePolicyModel.find(organizationId))?.rootRevision,
    ).toBeLessThan(0);
    const served =
      await openappaBatteriesService.getEffectivePolicy(organizationId);
    expect(served.rootRevision).toBe(stored.rootRevision + 1);
    expect(served.installFingerprint).not.toBe(stored.installFingerprint);
  });

  test("a recomposition that keeps losing the store asks the caller to retry", async ({
    makeOrganization,
  }) => {
    const organizationId = (await makeOrganization()).id;
    // Every composition loses its store to a write that landed meanwhile, the
    // shape a concurrent recompileAll and an install produce together.
    native.contend.each = () => storeUnrelatedComposition(organizationId);

    const failure = await openappaBatteriesService
      .recompile(organizationId)
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ statusCode: 503 });
    expect(native.composed.length).toBeGreaterThan(1);
  });

  test("a refused composition records the refusal and a later success clears it", async ({
    makeOrganization,
    makeUser,
    makeInternalMcpCatalog,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const userId = (await makeUser()).id;
    await makeInternalMcpCatalog({ organizationId, name: "Acme" });
    await declare({ organizationId, userId });
    const root = await guardrailsPolicyService.get(organizationId);

    native.refusals.next = true;
    const refused = await openappaBatteriesService.recompile(organizationId);
    expect(refused.lastError).toContain("refused");
    expect(refused.lastErrorAt).toBeInstanceOf(Date);
    // Nothing composed before, so the root is what the runtime keeps serving.
    expect(refused.content).toBe(root.content);
    expect(
      await OpenAppaEffectivePolicyModel.find(organizationId),
    ).toMatchObject({ lastError: refused.lastError });

    await OpenAppaEffectivePolicyModel.invalidate(organizationId);
    const accepted =
      await openappaBatteriesService.getEffectivePolicy(organizationId);
    expect(accepted.lastError).toBeNull();
    expect(accepted.lastErrorAt).toBeNull();
  });
});

/** A composition by some other writer: enough to make the caller's store lose. */
async function storeUnrelatedComposition(organizationId: string) {
  const marker = randomUUID();
  await OpenAppaEffectivePolicyModel.save({
    organizationId,
    values: {
      content: `# ${marker}`,
      contentHash: marker,
      rootRevision: 0,
      installFingerprint: marker,
      error: null,
    },
    expected: await OpenAppaEffectivePolicyModel.find(organizationId),
  });
}

/**
 * The root revision that includes the acme battery and points it at a catalog,
 * saved straight through the model: the service would compose the submitted text
 * to check it, and these tests count compositions.
 */
async function declare(params: { organizationId: string; userId: string }) {
  const latest = await guardrailsPolicyService.get(params.organizationId);
  const content = `include = ["batteries/acme/appa.toml"]\n\n[server_aliases]\nacme = ["acme"]\n\n${latest.content}`;
  const saved = await GuardrailsPolicyModel.save({
    organizationId: params.organizationId,
    updatedBy: params.userId,
    content,
    contentHash: createHash("sha256").update(content).digest("hex"),
    expectedRevision: latest.revision,
  });
  if (!saved) throw new Error("the policy revision was not saved");
  return saved;
}
