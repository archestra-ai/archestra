import { expect, test } from "vitest";
import type { PolicyBattery } from "@/lib/openappa-batteries.query";
import { batteryStatusHint, batteryTableStatus } from "./battery-table-status";

const battery = (fields: Partial<PolicyBattery> = {}): PolicyBattery => ({
  entry: "grain",
  name: "grain",
  source: "bundled",
  packageHash: null,
  status: "active",
  scope: "catalogs",
  composed: true,
  line: 1,
  servers: [{ target: "grain", catalogId: "catalog-grain" }],
  credentials: [],
  helpers: [],
  served: null,
  ...fields,
});
const credential = (key: string | null) => ({
  variable: "GRAIN_API_KEY",
  key,
  source: key === null ? null : ("binding" as const),
  readers: ["grain"],
});
const hint = (fields: Partial<PolicyBattery>) =>
  batteryStatusHint({
    battery: battery(fields),
    catalogName: (catalogId) => `name of ${catalogId}`,
  });

test("each backend status maps to one table status", () => {
  expect(batteryTableStatus(null)).toBe("not_configured");
  expect(batteryTableStatus(battery({ status: "active" }))).toBe("configured");
  expect(batteryTableStatus(battery({ status: "unrouted" }))).toBe(
    "configured",
  );
  expect(batteryTableStatus(battery({ status: "refused" }))).toBe("refused");
  // A refused policy enforces nothing, whatever the text would give it.
  expect(batteryTableStatus(battery({ status: "active" }), "refused")).toBe(
    "refused",
  );
  expect(batteryTableStatus(battery({ status: "missing_credentials" }))).toBe(
    "credential",
  );
  expect(batteryTableStatus(battery({ status: "server_missing" }))).toBe(
    "server",
  );
  expect(batteryTableStatus(battery({ status: "naming_conflict" }))).toBe(
    "conflict",
  );
  expect(batteryTableStatus(battery({ status: "unavailable" }))).toBe(
    "not_configured",
  );
});

test("a configured or absent battery has no hint", () => {
  expect(hint({ status: "active" })).toBeNull();
  expect(
    batteryStatusHint({ battery: null, catalogName: () => "" }),
  ).toBeNull();
});

test("a missing credential says whether to choose one or to add its value", () => {
  expect(
    hint({ status: "missing_credentials", credentials: [credential(null)] }),
  ).toBe(
    "Choose a credential for this battery. Open the battery and select one under Credentials.",
  );
  expect(
    hint({
      status: "missing_credentials",
      credentials: [credential("grain-key")],
    }),
  ).toBe(
    "The credential grain-key has no value for the organization. Add the value in Settings › Credentials.",
  );
});

test("a missing server says whether none is attached or it was uninstalled", () => {
  expect(hint({ status: "server_missing", servers: [] })).toMatch(
    /^This battery is not attached to an MCP server\./,
  );
  expect(
    hint({
      status: "server_missing",
      servers: [{ target: "grain", catalogId: null }],
    }),
  ).toMatch(/^The MCP server attached to this battery was uninstalled\./);
});

test("a server conflict names the shared prefix or the server with a bad prefix", () => {
  expect(
    hint({
      status: "naming_conflict",
      servers: [{ target: "jira", catalogId: null }],
    }),
  ).toBe(
    "More than one MCP server has the tool prefix jira. The battery cannot tell which server to check.",
  );
  expect(hint({ status: "naming_conflict" })).toBe(
    'The tools of name of catalog-grain have "__" in their prefix. Batteries cannot check these tools.',
  );
});
