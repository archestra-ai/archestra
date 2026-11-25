import { describe, expect, it } from "vitest";
import {
  catalogServersForType,
  MCP_APPS_DEMO_CATEGORY,
} from "./archestra-catalog-tab.utils";

// In the order the catalog sends them: by GitHub stars, highest first.
const servers = [
  { name: "filesystem", server: { type: "desktop" }, category: "Files" },
  { name: "context7", server: { type: "local" }, category: "Development" },
  { name: "blender", server: { type: "desktop" }, category: "Media" },
  { name: "github", server: { type: "remote" }, category: "Development" },
  {
    name: "apps-demo",
    server: { type: "local" },
    category: MCP_APPS_DEMO_CATEGORY,
  },
  { name: "grafana", server: { type: "local" }, category: null },
];

const names = (list: { name: string }[]) => list.map((server) => server.name);

describe("catalogServersForType", () => {
  it("lists desktop servers after the rest under all types, each group in the catalog's order", () => {
    expect(names(catalogServersForType(servers, "all"))).toEqual([
      "context7",
      "github",
      "grafana",
      "filesystem",
      "blender",
    ]);
  });

  it("lists one type alone in the catalog's order", () => {
    expect(names(catalogServersForType(servers, "desktop"))).toEqual([
      "filesystem",
      "blender",
    ]);
    expect(names(catalogServersForType(servers, "local"))).toEqual([
      "context7",
      "grafana",
    ]);
    expect(names(catalogServersForType(servers, "remote"))).toEqual(["github"]);
  });

  it("lists demo servers only under the MCP Apps Demo type", () => {
    expect(names(catalogServersForType(servers, "mcp-apps-demo"))).toEqual([
      "apps-demo",
    ]);
  });
});
