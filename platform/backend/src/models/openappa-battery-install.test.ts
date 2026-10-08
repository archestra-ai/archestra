import OpenAppaBatteryInstallModel from "@/models/openappa-battery-install";
import { describe, expect, test } from "@/test";
import type { BatteryInstallRow } from "@/types/openappa-batteries";

const row = (
  overrides: Partial<BatteryInstallRow> & { catalogId: string | null },
) => {
  const { catalogId, ...rest } = overrides;
  return {
    batteryName: "github",
    attachment:
      catalogId === null
        ? { kind: "organization" as const }
        : { kind: "catalog" as const, catalogId },
    status: "active",
    packageHash: null,
    lastError: null,
    credentialBindings: {},
    ...rest,
  } satisfies BatteryInstallRow;
};

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

  test("an organization-wide row is upserted in place rather than duplicated", async ({
    makeOrganization,
    makeInternalMcpCatalog,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const catalog = await makeInternalMcpCatalog({ organizationId });
    const rows = [
      row({ catalogId: null, batteryName: "jev" }),
      row({ catalogId: catalog.id }),
    ];

    const before = await OpenAppaBatteryInstallModel.replaceAll({
      organizationId,
      rows,
    });
    const after = await OpenAppaBatteryInstallModel.replaceAll({
      organizationId,
      rows: [
        { ...rows[0], status: "missing_credentials" },
        rows[1],
      ] as BatteryInstallRow[],
    });

    // Both rows are inserted by one statement, so `list` cannot order them.
    const byBattery = <T extends { batteryName: string }>(installs: T[]) =>
      [...installs].sort((a, b) => a.batteryName.localeCompare(b.batteryName));
    expect(byBattery(after).map((install) => install.id)).toEqual(
      byBattery(before).map((install) => install.id),
    );
    expect(
      byBattery(await OpenAppaBatteryInstallModel.list(organizationId)),
    ).toEqual([
      expect.objectContaining({
        batteryName: "github",
        kind: "catalog",
        catalogId: catalog.id,
        detectedId: null,
      }),
      expect.objectContaining({
        batteryName: "jev",
        kind: "organization",
        catalogId: null,
        detectedId: null,
        status: "missing_credentials",
      }),
    ]);
  });

  test("a detected server's row is its own identity beside the organization's", async ({
    makeOrganization,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const detected = {
      ...row({ catalogId: null, batteryName: "slack" }),
      attachment: {
        kind: "detected" as const,
        detectedId: "claude-code.slack",
      },
    };
    const before = await OpenAppaBatteryInstallModel.replaceAll({
      organizationId,
      rows: [detected, row({ catalogId: null, batteryName: "jev" })],
    });
    expect(before.map((install) => install.kind).sort()).toEqual([
      "detected",
      "organization",
    ]);
    const after = await OpenAppaBatteryInstallModel.replaceAll({
      organizationId,
      rows: [{ ...detected, status: "server_missing" }],
    });
    expect(after).toEqual([
      expect.objectContaining({
        id: before.find((install) => install.kind === "detected")?.id,
        kind: "detected",
        detectedId: "claude-code.slack",
        catalogId: null,
        status: "server_missing",
      }),
    ]);
  });

  test("two recomposes of one organization at once leave one row per identity", async ({
    makeOrganization,
    makeInternalMcpCatalog,
  }) => {
    const organizationId = (await makeOrganization()).id;
    const catalog = await makeInternalMcpCatalog({ organizationId });
    const rows = [
      row({ catalogId: catalog.id }),
      row({ catalogId: null, batteryName: "jev" }),
    ];

    const [first, second] = await Promise.all([
      OpenAppaBatteryInstallModel.replaceAll({ organizationId, rows }),
      OpenAppaBatteryInstallModel.replaceAll({ organizationId, rows }),
    ]);

    const stored = await OpenAppaBatteryInstallModel.list(organizationId);
    expect(stored).toHaveLength(2);
    const ids = (installs: { id: string }[]) =>
      installs.map((install) => install.id).sort();
    expect(ids(first)).toEqual(ids(stored));
    expect(ids(second)).toEqual(ids(stored));
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
