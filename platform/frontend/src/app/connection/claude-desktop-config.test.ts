import {
  CLAUDE_DESKTOP_CLIENT_ID,
  EXTERNAL_AGENT_ID_HEADER,
  VIRTUAL_KEY_HEADER,
} from "@archestra/shared";
import { describe, expect, it } from "vitest";
import {
  buildClaudeDesktopConfigProfile,
  generateConfigFilename,
  maskConfigSecrets,
} from "./claude-desktop-config";

describe("buildClaudeDesktopConfigProfile", () => {
  const base = {
    baseUrl: "https://example.com/v1",
    llmProxyId: "81a0379d-03f8-4319-93e3-27de2c82d4c9",
    passthroughKey: "arch_passthrough",
    virtualKey: "arch_virtual",
  };

  it("places both credentials in the inference block", () => {
    const profile = buildClaudeDesktopConfigProfile(base);

    expect(profile.$schemaVersion).toBe(2);
    expect(profile.inference.provider).toBe("gateway");
    // proxy id (not slug) in the inference base URL
    expect(profile.inference.baseUrl).toBe(
      "https://example.com/v1/anthropic/81a0379d-03f8-4319-93e3-27de2c82d4c9",
    );
    // passthrough key → custom header
    expect(profile.inference.customHeaders[VIRTUAL_KEY_HEADER]).toBe(
      "arch_passthrough",
    );
    // client attribution → custom header
    expect(profile.inference.customHeaders[EXTERNAL_AGENT_ID_HEADER]).toBe(
      CLAUDE_DESKTOP_CLIENT_ID,
    );
    // standard virtual key → static API credential
    expect(profile.inference.credential).toEqual({
      kind: "static",
      apiKey: "arch_virtual",
    });
  });

  it("omits the mcp block when no gateway is given", () => {
    expect(buildClaudeDesktopConfigProfile(base).mcp).toBeUndefined();
  });

  it("adds a managed MCP server using the gateway slug", () => {
    const profile = buildClaudeDesktopConfigProfile({
      ...base,
      gateway: { slug: "my-gateway-admin-de6a16", name: "My Gateway" },
    });

    expect(profile.mcp?.managedServers).toEqual([
      {
        name: "archestra-mcp-my-gateway-admin-de6a16",
        transport: "http",
        url: "https://example.com/v1/mcp/my-gateway-admin-de6a16",
        oauth: { mode: "dcr" },
        source: "user",
      },
    ]);
  });

  it("omits the plugins block when no skill marketplace is given", () => {
    expect(buildClaudeDesktopConfigProfile(base).plugins).toBeUndefined();
  });

  it("registers the shared-skills marketplace as a git plugin source", () => {
    const profile = buildClaudeDesktopConfigProfile({
      ...base,
      skillMarketplace: {
        cloneUrl: "https://example.com/skills/m/tok_abc123/repo.git",
        marketplaceName: "archestra-acme-corp-skills",
      },
    });

    expect(profile.plugins?.marketplaces).toEqual([
      {
        source: "git",
        url: "https://example.com/skills/m/tok_abc123/repo.git",
        expectedName: "archestra-acme-corp-skills",
      },
    ]);
  });
});

describe("maskConfigSecrets", () => {
  it("hides both key values while leaving the rest intact", () => {
    const profile = buildClaudeDesktopConfigProfile({
      ...{
        baseUrl: "https://example.com/v1",
        llmProxyId: "proxy-id",
        passthroughKey: "arch_passthrough",
        virtualKey: "arch_virtual",
      },
      gateway: { slug: "gw", name: "GW" },
    });

    const masked = maskConfigSecrets(profile);

    expect(masked.inference.customHeaders[VIRTUAL_KEY_HEADER]).not.toContain(
      "arch_passthrough",
    );
    expect(masked.inference.credential.apiKey).not.toContain("arch_virtual");
    // the client-attribution header is not a secret → stays visible
    expect(masked.inference.customHeaders[EXTERNAL_AGENT_ID_HEADER]).toBe(
      CLAUDE_DESKTOP_CLIENT_ID,
    );
    // non-secret fields and the original object are untouched
    expect(masked.inference.baseUrl).toBe(profile.inference.baseUrl);
    expect(masked.mcp).toEqual(profile.mcp);
    expect(profile.inference.credential.apiKey).toBe("arch_virtual");
  });

  it("masks the token-bearing marketplace URL but keeps its name", () => {
    const profile = buildClaudeDesktopConfigProfile({
      baseUrl: "https://example.com/v1",
      llmProxyId: "proxy-id",
      passthroughKey: "arch_passthrough",
      virtualKey: "arch_virtual",
      skillMarketplace: {
        cloneUrl: "https://example.com/skills/m/tok_secret/repo.git",
        marketplaceName: "archestra-acme-corp-skills",
      },
    });

    const masked = maskConfigSecrets(profile);

    expect(masked.plugins?.marketplaces[0].url).not.toContain("tok_secret");
    // the marketplace name isn't a secret → stays visible
    expect(masked.plugins?.marketplaces[0].expectedName).toBe(
      "archestra-acme-corp-skills",
    );
    // original object untouched
    expect(profile.plugins?.marketplaces[0].url).toBe(
      "https://example.com/skills/m/tok_secret/repo.git",
    );
  });
});

describe("generateConfigFilename", () => {
  it("produces a fresh archestra_con_ token each call", () => {
    const a = generateConfigFilename();
    const b = generateConfigFilename();

    expect(a).toMatch(/^archestra_con_[A-Za-z0-9_-]+$/);
    expect(b).toMatch(/^archestra_con_[A-Za-z0-9_-]+$/);
    // regenerated per call → effectively never collides
    expect(a).not.toBe(b);
  });
});
