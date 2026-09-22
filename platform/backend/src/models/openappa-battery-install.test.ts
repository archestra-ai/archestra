import OpenAppaBatteryInstallModel from "@/models/openappa-battery-install";
import { describe, expect, test } from "@/test";
import type { BatteryInstallRow } from "@/types/openappa-batteries";

const row = (overrides: Partial<BatteryInstallRow> & { catalogId: string }) =>
  ({
    batteryName: "github",
    status: "active",
    packageHash: null,
    lastError: null,
    credentialBindings: {},
    ...overrides,
  }) satisfies BatteryInstallRow;

describe("OpenAppaBatteryInstallModel.replaceAll", () => {
  test("keeps the id of a surviving row, updates it, and deletes the rest", async ({
    makeOrganization,
    makeInternalMcpCatalog,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const kept = await makeInternalMcpCatalog({ organizationId });
    const dropped = await makeInternalMcpCatalog({ organizationId });

    const before = await OpenAppaBatteryInstallModel.replaceAll({
      organizationId,
      rows: [
        row({ catalogId: kept.id }),
        row({ catalogId: dropped.id, batteryName: "linear" }),
      ],
    });
    expect(before).toHaveLength(2);
    const keptId = before[0].id;

    const after = await OpenAppaBatteryInstallModel.replaceAll({
      organizationId,
      rows: [
        row({
          catalogId: kept.id,
          status: "missing_credentials",
          packageHash: "hash-a",
          lastError: "no key for APPA_PROVIDER_GITHUB_TOKEN",
          credentialBindings: { APPA_PROVIDER_GITHUB_TOKEN: "github_token" },
        }),
      ],
    });

    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({
      id: keptId,
      status: "missing_credentials",
      packageHash: "hash-a",
      lastError: "no key for APPA_PROVIDER_GITHUB_TOKEN",
      credentialBindings: { APPA_PROVIDER_GITHUB_TOKEN: "github_token" },
      enabled: true,
    });
    expect(await OpenAppaBatteryInstallModel.list(organizationId)).toEqual(
      after,
    );
  });

  test("an empty declaration deletes the organization's rows and leaves another organization alone", async ({
    makeOrganization,
    makeInternalMcpCatalog,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const other = (await makeOrganization()).id;
    const catalog = await makeInternalMcpCatalog({ organizationId });
    const otherCatalog = await makeInternalMcpCatalog({
      organizationId: other,
    });

    await OpenAppaBatteryInstallModel.replaceAll({
      organizationId,
      rows: [row({ catalogId: catalog.id })],
    });
    await OpenAppaBatteryInstallModel.replaceAll({
      organizationId: other,
      rows: [row({ catalogId: otherCatalog.id })],
    });

    expect(
      await OpenAppaBatteryInstallModel.replaceAll({
        organizationId,
        rows: [],
      }),
    ).toEqual([]);
    expect(await OpenAppaBatteryInstallModel.list(organizationId)).toEqual([]);
    expect(await OpenAppaBatteryInstallModel.list(other)).toHaveLength(1);
  });
});
