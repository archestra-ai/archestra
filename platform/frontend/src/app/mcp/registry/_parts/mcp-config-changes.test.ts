import { describe, expect, it } from "vitest";
import type { McpCatalogFormValues } from "./mcp-catalog-form.types";
import {
  authSectionApplies,
  computeApplyChanges,
  headersSectionApplies,
} from "./mcp-config-changes";
import { parseMcpConfigText } from "./mcp-config-import";

function parsedServer(config: unknown) {
  const parsed = parseMcpConfigText(JSON.stringify(config));
  if (parsed.status !== "servers") throw new Error("fixture did not parse");
  return parsed.servers[0];
}

function remoteValues(overrides?: Partial<McpCatalogFormValues>) {
  return {
    ...parsedServer({ type: "http", url: "https://old.example.com/mcp" })
      .values,
    name: "old-server",
    ...overrides,
  } as McpCatalogFormValues;
}

describe("section gates", () => {
  it("authSectionApplies: remote always, local only when multitenant", () => {
    expect(authSectionApplies({ serverType: "remote" })).toBe(true);
    expect(
      authSectionApplies({ serverType: "local", multitenant: false }),
    ).toBe(false);
    expect(authSectionApplies({ serverType: "local", multitenant: true })).toBe(
      true,
    );
  });

  it("headersSectionApplies: remote always, local only over streamable-http", () => {
    expect(headersSectionApplies({ serverType: "remote" })).toBe(true);
    expect(
      headersSectionApplies({
        serverType: "local",
        localConfig: { transportType: "stdio" },
      }),
    ).toBe(false);
    expect(
      headersSectionApplies({
        serverType: "local",
        localConfig: { transportType: "streamable-http" },
      }),
    ).toBe(true);
  });
});

describe("computeApplyChanges", () => {
  it("reports a URL replacement with old and new values", () => {
    const plan = computeApplyChanges({
      current: remoteValues(),
      server: parsedServer({ type: "http", url: "https://new.example.com" }),
      allowServerTypeChange: false,
      transportConfigured: true,
    });
    if (!plan.applied) throw new Error(plan.reason);
    const urlChange = plan.changes.find((c) => c.label === "Server URL");
    expect(urlChange?.detail).toContain("https://old.example.com/mcp");
    expect(urlChange?.detail).toContain("https://new.example.com");
    expect(plan.touchedPaths).toContain("serverUrl");
  });

  it("refuses a type mismatch when the type is locked", () => {
    const plan = computeApplyChanges({
      current: remoteValues(),
      server: parsedServer({ command: "npx", args: ["-y", "server-a"] }),
      allowServerTypeChange: false,
      transportConfigured: true,
    });
    expect(plan.applied).toBe(false);
  });

  it("never mutates the real current values (shadow apply)", () => {
    const current = remoteValues();
    const before = JSON.stringify(current);
    computeApplyChanges({
      current,
      server: parsedServer({ type: "http", url: "https://new.example.com" }),
      allowServerTypeChange: false,
      transportConfigured: true,
    });
    expect(JSON.stringify(current)).toBe(before);
  });

  it("summarizes env-var deltas as counts, with stored secret rows kept", () => {
    const stored = parsedServer({
      command: "npx",
      env: { API_TOKEN: "<token>", REGION: "eu" },
    }).values as McpCatalogFormValues;
    // Simulate the stored state: the prompted token row became a stored secret.
    const local = stored.localConfig;
    if (!local) throw new Error("expected local config");
    const current = {
      ...stored,
      name: "files",
      localConfig: {
        ...local,
        environment: [
          {
            key: "API_TOKEN",
            type: "secret" as const,
            value: "stored-secret",
            promptOnInstallation: false,
            required: false,
            description: "",
          },
          local.environment.find((env) => env.key === "REGION"),
        ].filter((env) => env !== undefined),
      },
    } as McpCatalogFormValues;

    const plan = computeApplyChanges({
      current,
      server: parsedServer({
        command: "npx",
        env: { API_TOKEN: "<token>", REGION: "us", NEW_FLAG: "on" },
      }),
      allowServerTypeChange: false,
      transportConfigured: true,
    });
    if (!plan.applied) throw new Error(plan.reason);
    const envChange = plan.changes.find(
      (c) => c.label === "Environment variables",
    );
    // API_TOKEN: prompted placeholder keeps the stored row (unchanged);
    // REGION: value changes (replaced); NEW_FLAG: added.
    expect(envChange?.detail).toContain("1 added");
    expect(envChange?.detail).toContain("1 replaced");
    expect(envChange?.detail).toContain("1 unchanged");
    expect(envChange?.detail).toContain("stored secrets kept");
  });

  it("names the section-gating consequence of a type switch and what is kept", () => {
    const current = remoteValues({ authMethod: "oauth" });
    const plan = computeApplyChanges({
      current,
      server: parsedServer({ command: "npx", args: ["-y", "server-a"] }),
      allowServerTypeChange: true,
      transportConfigured: true,
    });
    if (!plan.applied) throw new Error(plan.reason);
    expect(
      plan.changes.find((c) => c.label === "Server Type")?.detail,
    ).toContain("Self-hosted");
    expect(plan.gating.join(" ")).toContain("won't apply");
    expect(plan.kept).toContain("OAuth 2.1 setup");
  });

  it("fills Name only when the form name is empty", () => {
    const plan = computeApplyChanges({
      current: remoteValues({ name: "" }),
      server: parsedServer({
        mcpServers: { github: { type: "http", url: "https://x.example" } },
      }),
      allowServerTypeChange: false,
      transportConfigured: true,
    });
    if (!plan.applied) throw new Error(plan.reason);
    expect(plan.changes.find((c) => c.label === "Name")?.detail).toContain(
      "github",
    );

    const planKept = computeApplyChanges({
      current: remoteValues({ name: "Existing Name" }),
      server: parsedServer({
        mcpServers: { github: { type: "http", url: "https://x.example" } },
      }),
      allowServerTypeChange: false,
      transportConfigured: true,
    });
    if (!planKept.applied) throw new Error(planKept.reason);
    expect(planKept.changes.find((c) => c.label === "Name")).toBeUndefined();
  });
});
