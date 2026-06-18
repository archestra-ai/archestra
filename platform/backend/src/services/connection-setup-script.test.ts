import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import {
  buildSetupCommand,
  proxyBaseUrlToOrigin,
  renderSetupScript,
  type SetupScriptContext,
} from "@/services/connection-setup-script";

const execFileAsync = promisify(execFile);

const MCP = {
  serverName: "prod_gateway",
  url: "https://archestra.example.com/v1/mcp/prod-gateway",
};

const PROXY = {
  authMode: "virtual-key" as const,
  provider: "anthropic" as const,
  providerLabel: "Anthropic",
  url: "https://archestra.example.com/v1/anthropic/profile-123",
  proxyName: "default_proxy",
  virtualKey: "arch_deadbeefcafe",
  virtualKeyName: "Connection setup — user@example.com",
};

const GITHUB_COPILOT_PROXY = {
  authMode: "provider-key" as const,
  provider: "github-copilot" as const,
  providerLabel: "GitHub Copilot",
  url: "https://archestra.example.com/v1/github-copilot/profile-123",
  proxyName: "default_proxy",
  virtualKey: null,
  virtualKeyName: null,
  githubCopilot: {
    tokenExchangeUrl:
      "https://api.github.example.com/copilot_internal/v2/token",
    deviceAuthBaseUrl: "https://github.example.com",
    clientId: "Iv1.testclientid",
  },
};

const SKILLS = {
  cloneUrl:
    "https://archestra.example.com/skill-marketplace/archestra_skl_token123/repo.git",
  marketplaceName: "acme-skills",
};

function fullContext(
  clientId: SetupScriptContext["clientId"],
): SetupScriptContext {
  return {
    clientId,
    appName: "Archestra",
    mcp: MCP,
    proxy:
      clientId === "claude-code"
        ? PROXY
        : { ...PROXY, provider: "openai", providerLabel: "OpenAI" },
    skills: SKILLS,
  };
}

/** Every rendered variant must be parseable bash. */
async function expectValidBash(script: string): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "archestra-script-"));
  const file = path.join(dir, "setup.sh");
  try {
    await writeFile(file, script, "utf8");
    await execFileAsync("bash", ["-n", file]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const ALL_CLIENTS = ["claude-code", "codex", "copilot-cli", "cursor"] as const;

describe("renderSetupScript", () => {
  for (const clientId of ALL_CLIENTS) {
    test(`${clientId}: full script is valid bash with no placeholders`, async () => {
      const script = renderSetupScript(fullContext(clientId));

      await expectValidBash(script);
      expect(script).toContain("set -euo pipefail");
      // Every heredoc must use a quoted delimiter: unquoted heredocs expand
      // $(...) in embedded data (URLs derive from user-supplied baseUrl).
      expect(script).not.toMatch(/<<[ \t]*ARCHESTRA/);
      // No leftover template placeholders.
      expect(script).not.toMatch(/<your-[a-z-]+>/);
      expect(script).not.toContain("archestra_TOKEN");
      // Secrets are injected.
      expect(script).toContain(PROXY.virtualKey);
      expect(script).toContain(SKILLS.cloneUrl);
      // Revocation guidance present.
      expect(script).toContain(PROXY.virtualKeyName);
      expect(script).toContain(SKILLS.marketplaceName);
    });

    test(`${clientId}: sections are omitted when not selected`, async () => {
      const script = renderSetupScript({
        clientId,
        appName: "Archestra",
        mcp: MCP,
        proxy: null,
        skills: null,
      });

      await expectValidBash(script);
      expect(script).toContain(MCP.url);
      expect(script).not.toContain(PROXY.virtualKey);
      expect(script).not.toContain("marketplace");
    });
  }

  test("claude-code: registers gateway idempotently and merges settings.json", () => {
    const script = renderSetupScript(fullContext("claude-code"));
    expect(script).toContain(
      "claude mcp remove 'prod_gateway' >/dev/null 2>&1 || true",
    );
    expect(script).toContain(
      `claude mcp add --transport http 'prod_gateway' '${MCP.url}'`,
    );
    expect(script).toContain("ANTHROPIC_BASE_URL");
    expect(script).toContain("ANTHROPIC_AUTH_TOKEN");
    expect(script).toContain(
      `claude plugin marketplace add '${SKILLS.cloneUrl}'`,
    );
    // python3 fallback prints a manual snippet rather than failing.
    expect(script).toContain("python3 not found");
  });

  test("claude-code bedrock: keeps the bearer token out of settings.json", () => {
    const script = renderSetupScript({
      ...fullContext("claude-code"),
      proxy: {
        ...PROXY,
        provider: "bedrock",
        providerLabel: "Bedrock",
        url: "https://archestra.example.com/v1/bedrock/profile-123",
      },
    });
    expect(script).toContain("CLAUDE_CODE_USE_BEDROCK");
    expect(script).toContain("ANTHROPIC_BEDROCK_BASE_URL");
    expect(script).toContain("AWS_BEARER_TOKEN_BEDROCK");
    // The secret goes to the profile-paste block, not the settings merge env.
    expect(script).not.toContain(`ARCHESTRA_SET_ENV_AWS_BEARER_TOKEN_BEDROCK`);
  });

  test("codex: manages a marker-delimited TOML block and logs in via stdin", () => {
    const script = renderSetupScript(fullContext("codex"));
    expect(script).toContain("# >>> archestra:default_proxy >>>");
    expect(script).toContain("[model_providers.default_proxy]");
    expect(script).toContain('wire_api = "responses"');
    expect(script).toContain("requires_openai_auth = true");
    expect(script).toContain(
      `printf '%s' "$ARCHESTRA_VIRTUAL_KEY" | codex login --with-api-key`,
    );
    // The virtual key is assigned to a variable, never an argv of codex.
    expect(script).not.toContain(
      `codex login --with-api-key ${PROXY.virtualKey}`,
    );
  });

  test("copilot-cli: prints export lines instead of exporting into a dead shell", () => {
    const script = renderSetupScript(fullContext("copilot-cli"));
    expect(script).toContain('export COPILOT_PROVIDER_TYPE="openai"');
    expect(script).toContain("export COPILOT_PROVIDER_API_KEY=");
    expect(script).toContain("copilot mcp add --transport http");
    expect(script).toContain("copilot mcp get");
  });

  test("copilot-cli github-copilot passthrough: links GitHub in-script, token never in argv", async () => {
    const script = renderSetupScript({
      ...fullContext("copilot-cli"),
      proxy: GITHUB_COPILOT_PROXY,
    });
    await expectValidBash(script);

    // token reuse from the Copilot CLI's local config, then validation
    expect(script).toContain("github-copilot/apps.json");
    expect(script).toContain("github-copilot/hosts.json");
    expect(script).toContain("ghcp_validate");
    // device-flow endpoints + client id from the server-provided config
    expect(script).toContain("https://github.example.com/login/device/code");
    expect(script).toContain(
      "https://github.example.com/login/oauth/access_token",
    );
    expect(script).toContain('{"client_id":"Iv1.testclientid"');
    expect(script).toContain("urn:ietf:params:oauth:grant-type:device_code");
    // RFC 8628 poll semantics: slow_down backoff + expires_in deadline
    expect(script).toContain("slow_down) ghcp_interval=$((ghcp_interval + 5))");
    expect(script).toContain("ghcp_deadline");
    // the token travels via stdin curl config / printf, never argv
    expect(script).toContain(`printf 'header = "authorization: token %s"`);
    // never the well-known CI variable name
    expect(script).not.toContain("GITHUB_TOKEN");
    // export lines come from printf with the runtime token
    expect(script).toContain('"$ARCHESTRA_GHCP_TOKEN"');
    expect(script).toContain('export COPILOT_PROVIDER_TYPE="openai"');
  });

  test("copilot-cli github-copilot virtual-key: injects the virtual key, no device flow", async () => {
    const script = renderSetupScript({
      ...fullContext("copilot-cli"),
      proxy: {
        ...GITHUB_COPILOT_PROXY,
        authMode: "virtual-key" as const,
        virtualKey: "arch_deadbeefcafe",
        virtualKeyName: "Connection setup — user@example.com",
        githubCopilot: null,
      },
    });
    await expectValidBash(script);
    expect(script).toContain("'arch_deadbeefcafe'");
    expect(script).not.toContain("login/device/code");
    expect(script).not.toContain("ghcp_validate");
  });

  test("github-copilot passthrough without device-flow config throws", () => {
    expect(() =>
      renderSetupScript({
        ...fullContext("copilot-cli"),
        proxy: { ...GITHUB_COPILOT_PROXY, githubCopilot: null },
      }),
    ).toThrow(/device-flow configuration/);
  });

  test("github-copilot: hostile server values stay literal in the link section", async () => {
    const hostile = "https://github.example.com/$(touch /tmp/pwned)";
    const script = renderSetupScript({
      ...fullContext("copilot-cli"),
      proxy: {
        ...GITHUB_COPILOT_PROXY,
        url: `${hostile}/v1/github-copilot/profile-123`,
        githubCopilot: {
          tokenExchangeUrl: `${hostile}/token`,
          deviceAuthBaseUrl: hostile,
          clientId: `Iv1.$(touch /tmp/pwned)`,
        },
      },
    });
    await expectValidBash(script);
    expect(script).toContain(hostile);
    expect(script).not.toMatch(/<<[ \t]*ARCHESTRA/);
  });

  test("cursor: merges mcp.json without auth headers (OAuth) and prints manual proxy steps", () => {
    const script = renderSetupScript(fullContext("cursor"));
    expect(script).toContain("ARCHESTRA_MCP_SERVER_NAME");
    expect(script).not.toContain("Authorization");
    expect(script).toContain("Override OpenAI Base URL");
    expect(script).toContain("/add-plugin");
  });
});

describe("shell-injection resistance", () => {
  test("hostile URLs stay literal (never expanded) in every client script", async () => {
    const hostileUrl =
      "https://archestra.example.com/v1$(touch /tmp/pwned)/mcp/x";
    for (const clientId of ALL_CLIENTS) {
      const ctx = fullContext(clientId);
      const script = renderSetupScript({
        ...ctx,
        mcp: { ...MCP, url: hostileUrl },
        proxy: ctx.proxy ? { ...ctx.proxy, url: hostileUrl } : null,
        skills: { ...SKILLS, cloneUrl: hostileUrl },
      });
      await expectValidBash(script);
      // The hostile content survives verbatim (it would render mangled or
      // expanded if it passed through an unquoted context).
      expect(script).toContain(hostileUrl);
      expect(script).not.toMatch(/<<[ \t]*ARCHESTRA/);
    }
  });
});

describe("banner", () => {
  test("default app shows the ASCII mark + details; white-label drops the mark", async () => {
    const branded = renderSetupScript(fullContext("claude-code"));
    await expectValidBash(branded);
    expect(branded).toContain("cat <<'ARCHESTRA_BANNER'");
    expect(branded).toContain("Secure access to your AI tools");
    expect(branded).toContain("Client:     Claude Code");
    expect(branded).toContain("Configures:");
    expect(branded).toContain("one-time setup");

    const whiteLabel = renderSetupScript({
      ...fullContext("claude-code"),
      appName: "Acme AI",
    });
    await expectValidBash(whiteLabel);
    expect(whiteLabel).toContain("Acme AI");
    // the Archestra slash-mark is not printed under a custom brand
    expect(whiteLabel).not.toContain("/_/");
  });
});

describe("appName sanitization", () => {
  test("collapses control characters so they cannot break out of comments", async () => {
    const script = renderSetupScript({
      ...fullContext("claude-code"),
      appName: "Evil\n# rm -rf / # Co",
    });
    await expectValidBash(script);
    // the newline is gone — no line in the script starts an injected command
    expect(script).not.toContain("\n# rm -rf /");
    expect(script).toContain("Evil # rm -rf / # Co setup");
  });
});

describe("buildSetupCommand / proxyBaseUrlToOrigin", () => {
  test("strips the /v1 suffix and builds the one-liner", () => {
    expect(proxyBaseUrlToOrigin("https://host.example.com/v1")).toBe(
      "https://host.example.com",
    );
    expect(proxyBaseUrlToOrigin("https://host.example.com/v1/")).toBe(
      "https://host.example.com",
    );
    expect(proxyBaseUrlToOrigin("http://localhost:9000")).toBe(
      "http://localhost:9000",
    );

    expect(
      buildSetupCommand({
        origin: "https://host.example.com",
        rawToken: "archestra_con_abc",
      }),
    ).toBe(
      "curl -fsSL 'https://host.example.com/api/connection-setups/script/archestra_con_abc' | bash",
    );
  });
});
