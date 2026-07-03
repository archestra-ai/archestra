import { describe, expect, it } from "vitest";
import { sortCatalogItems } from "./registry-list-controls";

const item = (id: string, name: string) => ({
  id,
  name,
  createdAt: "2026-01-01T00:00:00.000Z",
});

describe("sortCatalogItems usage sorts", () => {
  const items = [
    item("busy", "Busy Server"),
    item("idle", "Idle Server"),
    item("light", "Light Server"),
  ];
  const usage = new Map([
    ["busy", 120],
    ["light", 3],
  ]);

  it("least-used surfaces never-called servers first (missing usage counts as 0)", () => {
    // "idle" has no usage entry at all — it must sort as 0 calls, ahead of
    // servers with any recorded usage.
    expect(
      sortCatalogItems(items, "least-used", usage).map((i) => i.id),
    ).toEqual(["idle", "light", "busy"]);
  });

  it("most-used orders by descending call count", () => {
    expect(
      sortCatalogItems(items, "most-used", usage).map((i) => i.id),
    ).toEqual(["busy", "light", "idle"]);
  });

  it("ties break alphabetically so equal counts keep a stable order", () => {
    const tied = [item("b", "Beta"), item("a", "Alpha"), item("c", "Gamma")];
    expect(
      sortCatalogItems(tied, "least-used", new Map()).map((i) => i.name),
    ).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("usage sorts fall back to 0 while usage data has not loaded", () => {
    // No map at all (query still loading) — order degrades to the name
    // tie-break instead of throwing or reshuffling arbitrarily.
    expect(
      sortCatalogItems(items, "least-used", undefined).map((i) => i.name),
    ).toEqual(["Busy Server", "Idle Server", "Light Server"]);
  });
});
