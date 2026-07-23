import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, test } from "vitest";
import {
  buildStartupGuardInstallSection,
  renderStartupGuardScript,
  type StartupGuardClient,
  type StartupGuardContext,
} from "@/services/startup-guard";
import {
  CODEX_GUARD_CLIENT,
  COPILOT_GUARD_CLIENT,
} from "@/services/startup-guard.clients";

const execFileAsync = promisify(execFile);

const CTX: StartupGuardContext = {
  appName: "Archestra",
  healthUrl:
    "https://archestra.example.com/v1/health?mcp=prod-gateway&llm=acme-proxy",
  proxy: {
    provider: "openai",
    providerLabel: "OpenAI",
    url: "https://archestra.example.com/v1/openai/acme-proxy",
    ref: "acme-proxy",
    proxyName: "acme_proxy",
  },
  mcp: {
    serverName: "prod_gateway",
    url: "https://archestra.example.com/v1/mcp/prod-gateway",
    ref: "prod-gateway",
  },
  skills: {
    marketplaceName: "acme-skills",
    cloneUrl:
      "https://archestra.example.com/skill-marketplace/archestra_skl_token123/repo.git",
  },
};

async function expectValidBash(script: string): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "archestra-guard-"));
  const file = path.join(dir, "guard.sh");
  try {
    await writeFile(file, script, "utf8");
    await execFileAsync("bash", ["-n", file]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// Behavior common to every non-Claude client: the shared engine is already
// pinned by startup-guard.test.ts against the Claude descriptor, so here we
// only assert each descriptor injects the right client-specific strings and
// that the result is still valid bash.
describe.each([
  { name: "Codex", client: CODEX_GUARD_CLIENT },
  { name: "Copilot CLI", client: COPILOT_GUARD_CLIENT },
])("$name startup guard", ({ client }: { client: StartupGuardClient }) => {
  test("renders valid bash for the guard script and its install section", async () => {
    await expectValidBash(renderStartupGuardScript(CTX, client));
    await expectValidBash(
      `set -euo pipefail\nsay() { :; }\nok() { :; }\nwarn() { :; }\n${buildStartupGuardInstallSection(CTX, client)}`,
    );
  });

  test("wraps the client's own binary behind its own disable flag and paths", () => {
    const script = renderStartupGuardScript(CTX, client);
    const install = buildStartupGuardInstallSection(CTX, client);
    expect(script).toContain(`[ "\${${client.disableEnvVar}:-1}" = "0" ]`);
    expect(script).toContain(`GUARD_PATH="$HOME/${client.scriptRelpath}"`);
    // the profile wrapper re-execs the real binary after the guard
    expect(install).toContain(`${client.binary}() {`);
    expect(install).toContain(`command ${client.binary} "$@"`);
    expect(install).toContain(client.markerStart);
  });

  test("prompts name the client and disconnect mirrors its own CLI", () => {
    const script = renderStartupGuardScript(CTX, client);
    expect(script).toContain(`from ${client.promptName} now? (Y/n)`);
    expect(script).toContain(`command ${client.binary} mcp remove`);
  });
});

describe("Codex-specific disconnect", () => {
  test("strips the archestra provider block it wrote to ~/.codex/config.toml", () => {
    const script = renderStartupGuardScript(CTX, CODEX_GUARD_CLIENT);
    expect(script).toContain('CONFIG="$HOME/.codex/config.toml"');
    // the awk-delimited block is keyed by the proxy slug connect used
    expect(script).toContain("# >>> archestra:acme_proxy >>>");
    expect(script).toContain("# <<< archestra:acme_proxy <<<");
    // `codex exec` is the non-interactive path the guard bows out on
    expect(script).toContain("exec) INTERACTIVE=0");
  });
});

describe("Copilot-specific disconnect", () => {
  test("strips the COPILOT_PROVIDER_* export lines from the shell profiles", () => {
    const script = renderStartupGuardScript(CTX, COPILOT_GUARD_CLIENT);
    expect(script).toContain(
      "export[[:space:]]+COPILOT_PROVIDER_(TYPE|BASE_URL|API_KEY)=",
    );
    expect(script).toContain('"$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.profile"');
    // Copilot's non-interactive one-shot flag
    expect(script).toContain("-p|--prompt) INTERACTIVE=0");
  });
});
