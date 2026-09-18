import { vi } from "vitest";
import config from "@/config";
import OpenAppaBatteryInstallModel from "@/models/openappa-battery-install";
import OpenAppaEffectivePolicyModel from "@/models/openappa-effective-policy";
import { beforeEach, describe, expect, test } from "@/test";
import { openappaBatteriesService } from "./batteries";

const native = vi.hoisted(() => {
  let release: (() => void) | null = null;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const composed: string[][] = [];
  return {
    composed,
    releaseFirst: () => release?.(),
    listBundledOpenappaBatteries: vi.fn(async () => [
      {
        name: "acme",
        description: "",
        hosts: ["archestra"],
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
        // The first composition has read its inputs and now stalls, so a
        // write can land while it is in flight.
        if (composed.length === 1) await gate;
        return { content: input.root, errors: [] };
      },
    ),
  };
});
vi.mock("@archestra/openappa-rs", () => native);

describe("recompile coalescing", () => {
  beforeEach(() => {
    config.openappa.enabled = true;
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

    const stale = openappaBatteriesService.recompile(organizationId);
    await vi.waitFor(() => expect(native.composed).toHaveLength(1));
    await OpenAppaBatteryInstallModel.create({
      organizationId,
      batteryName: "acme",
      catalogId: catalog.id,
      enabled: true,
      credentialBindings: {},
    });
    const afterWrite = openappaBatteriesService.recompile(organizationId);
    const alsoAfterWrite = openappaBatteriesService.recompile(organizationId);
    native.releaseFirst();

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
});
