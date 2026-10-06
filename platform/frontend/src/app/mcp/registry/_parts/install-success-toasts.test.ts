// @vitest-environment node
import { describe, expect, test } from "vitest";
import { selectInstallSuccessToastIds } from "./install-success-toasts";

const row = (id: string, catalogId: string, status: string) => ({
  id,
  catalogId,
  localInstallationStatus: status,
});

describe("selectInstallSuccessToastIds", () => {
  test("toasts once when a shared deployment rollout completes every install row together", () => {
    const servers = [
      row("a", "mt", "success"),
      row("b", "mt", "success"),
      row("c", "mt", "success"),
    ];
    expect(
      selectInstallSuccessToastIds({
        completedIds: ["a", "b", "c"],
        servers,
        multitenantCatalogIds: new Set(["mt"]),
      }),
    ).toEqual(["a"]);
  });

  test("waits for the last row of a shared deployment when rows finish across updates", () => {
    const multitenantCatalogIds = new Set(["mt"]);
    expect(
      selectInstallSuccessToastIds({
        completedIds: ["a"],
        servers: [row("a", "mt", "success"), row("b", "mt", "pending")],
        multitenantCatalogIds,
      }),
    ).toEqual([]);
    expect(
      selectInstallSuccessToastIds({
        completedIds: ["b"],
        servers: [row("a", "mt", "success"), row("b", "mt", "success")],
        multitenantCatalogIds,
      }),
    ).toEqual(["b"]);
  });

  test("toasts each single-tenant install, since each is its own deployment", () => {
    const servers = [row("a", "st", "success"), row("b", "st", "success")];
    expect(
      selectInstallSuccessToastIds({
        completedIds: ["a", "b"],
        servers,
        multitenantCatalogIds: new Set(),
      }),
    ).toEqual(["a", "b"]);
  });

  test("does not toast failed installs", () => {
    expect(
      selectInstallSuccessToastIds({
        completedIds: ["a", "b"],
        servers: [row("a", "mt", "error"), row("b", "st", "error")],
        multitenantCatalogIds: new Set(["mt"]),
      }),
    ).toEqual([]);
  });
});
