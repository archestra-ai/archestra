import { vi } from "vitest";
import config from "@/config";
import OpenAppaBatteryInstallModel from "@/models/openappa-battery-install";
import OpenAppaEffectivePolicyModel from "@/models/openappa-effective-policy";
import { beforeEach, describe, expect, test } from "@/test";
import { openappaBatteriesService } from "./batteries";

const native = vi.hoisted(() => {
  let release: (() => void) | null = null;
  const stall = { next: null as Promise<void> | null };
  const composed: string[][] = [];
  const failures = { next: false };
  return {
    composed,
    failures,
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
        policy: "",
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
        const wait = stall.next;
        stall.next = null;
        if (wait) await wait;
        return { content: input.root, errors: [] };
      },
    ),
  };
});
vi.mock("@archestra/openappa-rs", () => native);

describe("recompile coalescing", () => {
  beforeEach(() => {
    config.openappa.enabled = true;
    native.composed.length = 0;
  });

  test("a caller never joins a composition that started before its write", async ({
    makeOrganization,
    makeInternalMcpCatalog,
    makeTool,
  }) => {
    const organizationId = (await makeOrganization()).id;
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
    await attach({
      organizationId,
      batteryName: "acme",
      catalogId: catalog.id,
      enabled: true,
      credentialBindings: {},
    });
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
    makeInternalMcpCatalog,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const stored = await openappaBatteriesService.recompile(organizationId);
    const catalog = await makeInternalMcpCatalog({
      organizationId,
      name: "Acme",
    });
    await attach({
      organizationId,
      batteryName: "acme",
      catalogId: catalog.id,
      enabled: true,
      credentialBindings: {},
    });
    native.failures.next = true;
    await expect(
      openappaBatteriesService.recompile(organizationId),
    ).rejects.toThrow();
    expect(
      (await OpenAppaEffectivePolicyModel.find(organizationId))?.rootRevision,
    ).toBeLessThan(0);
    const served =
      await openappaBatteriesService.getEffectivePolicy(organizationId);
    expect(served.rootRevision).toBe(stored.rootRevision);
    expect(served.installFingerprint).not.toBe(stored.installFingerprint);
  });
});

/** An install the test relies on; the unique index cannot refuse a fresh catalog. */
async function attach(
  params: Parameters<typeof OpenAppaBatteryInstallModel.createIfAbsent>[0],
) {
  const install = await OpenAppaBatteryInstallModel.createIfAbsent(params);
  if (!install) throw new Error("the battery install already existed");
  return install;
}
