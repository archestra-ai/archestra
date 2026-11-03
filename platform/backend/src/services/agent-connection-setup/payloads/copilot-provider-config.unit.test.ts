import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { COPILOT_GUARD_CLIENT } from "../guard/clients/copilot-cli";
import { buildStartupGuardContext } from "../guard/startup-guard";
import { renderSetupScript, type SetupScriptContext } from "../index";
import { COPILOT_PROVIDER_CONFIG_NODE } from "./copilot-provider-config";

const exec = promisify(execFile);
const homes: string[] = [];
const proxy = {
  authMode: "virtual-key" as const,
  provider: "openai" as const,
  providerLabel: "OpenAI",
  baseUrl: "https://proxy.example.com/v1",
  url: "https://proxy.example.com/v1/openai",
  proxyName: "default_proxy",
  virtualKey: "arch_test'$`\\key",
  virtualKeyName: "test",
  passthroughVirtualKey: "arch_attribution",
  model: "gpt-4o",
};
const context: SetupScriptContext = {
  clientId: "copilot-cli",
  platform: "macos",
  appName: "Test",
  mcp: null,
  skills: null,
  proxy,
};
afterEach(async () => {
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});
async function fixture() {
  const home = await mkdtemp(path.join(tmpdir(), "copilot-registry-test-"));
  homes.push(home);
  const bin = path.join(home, "bin");
  await mkdir(bin);
  await writeFile(
    path.join(bin, "copilot"),
    "#!/bin/sh\nif [ \"$1\" = --version ]; then echo 'GitHub Copilot CLI 1.0.95'; fi\nexit 0\n",
  );
  await chmod(path.join(bin, "copilot"), 0o755);
  const env = {
    ...process.env,
    HOME: home,
    ZDOTDIR: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    COPILOT_HOME: path.join(home, ".copilot"),
    COPILOT_PROVIDERS_CONFIG: "",
    COPILOT_PROVIDER_API_KEY: "",
    PATH: `${bin}:${process.env.PATH}`,
    SHELL: "/bin/bash",
    NO_COLOR: "1",
  };
  const registry = path.join(env.COPILOT_HOME, "providers.json");
  const settings = path.join(env.COPILOT_HOME, "settings.json");
  await mkdir(env.COPILOT_HOME);
  const run = async (ctx = context, extraEnv: Record<string, string> = {}) => {
    const script = path.join(home, "setup.sh");
    await writeFile(script, renderSetupScript(ctx));
    return exec("bash", [script], { env: { ...env, ...extraEnv } });
  };
  const remove = () =>
    exec(process.execPath, ["-e", COPILOT_PROVIDER_CONFIG_NODE], {
      env: {
        ...env,
        ARCHESTRA_COPILOT_ACTION: "remove",
        ARCHESTRA_COPILOT_CONFIG: JSON.stringify({ url: proxy.url }),
      },
    });
  return { home, env, registry, settings, run, remove };
}
async function json(file: string) {
  return JSON.parse(await readFile(file, "utf8"));
}

test("setup saves credentials and model, preserves other settings, reruns safely, then disconnect restores the model", async () => {
  const f = await fixture();
  const original = {
    providers: [
      { name: "personal", type: "openai", baseUrl: "http://localhost:1234" },
    ],
    models: [{ id: "local", provider: "personal" }],
  };
  await writeFile(f.registry, JSON.stringify(original));
  await writeFile(
    f.settings,
    '{\n// Keep preferences\n"model":"personal/local", "theme":"dark", "custom":"//literal,}",\n}',
  );
  const { stdout } = await f.run();
  const installed = await json(f.registry);
  expect(installed.providers).toEqual([
    ...original.providers,
    {
      name: "archestra",
      type: "openai",
      baseUrl: proxy.url,
      headers: {
        "X-Archestra-Agent-Id": "github_copilot_cli",
        "X-Archestra-Virtual-Key": "arch_attribution",
      },
      // OpenAI serves the Responses API, the wire Guardrails follow Copilot on.
      wireApi: "responses",
      apiKey: proxy.virtualKey,
    },
  ]);
  expect(installed.models).toContainEqual({
    id: "gpt-4o",
    provider: "archestra",
    modelId: "gpt-4o",
    wireModel: "gpt-4o",
  });
  expect(await json(f.settings)).toEqual({
    model: "archestra/gpt-4o",
    theme: "dark",
    custom: "//literal,}",
  });
  expect((await stat(f.registry)).mode & 0o777).toBe(0o600);
  expect((await stat(`${f.registry}.archestra-backup`)).mode & 0o777).toBe(
    0o600,
  );
  expect(stdout).not.toMatch(/<your-[a-z-]+>/);
  // The closing note names the saved model and says to leave COPILOT_MODEL
  // unset; the former "optional" exports (which set it) are gone.
  expect(stdout.indexOf("Model selection")).toBeGreaterThan(
    stdout.indexOf("Copilot CLI is connected"),
  );
  expect(stdout).toContain("Copilot starts with archestra/gpt-4o");
  expect(stdout.indexOf("Next: open a new terminal")).toBeGreaterThan(
    stdout.indexOf("Leave COPILOT_MODEL unset"),
  );
  expect(stdout).not.toContain("export COPILOT_");
  expect(stdout).not.toContain("COPILOT_MODEL is set to");
  expect(stdout).not.toContain("Removed the COPILOT_MODEL export");
  await f.run({ ...context, proxy: { ...proxy, model: "gpt-4.1" } });
  expect(
    (await json(f.registry)).models.filter(
      (model: { provider: string }) => model.provider === "archestra",
    ),
  ).toHaveLength(1);
  expect(await json(`${f.registry}.archestra-backup`)).toEqual(original);
  // Exports an earlier setup's instructions had people add by hand.
  await writeFile(
    path.join(f.home, ".zshrc"),
    "export COPILOT_PROVIDER_API_KEY='arch_test'\nexport COPILOT_MODEL='archestra/gpt-4o'\nexport KEEP_ME=1\n",
  );
  await mkdir(path.join(f.home, ".config/fish/conf.d"), { recursive: true });
  const fishProfile = path.join(f.home, ".config/fish/conf.d/provider.fish");
  await writeFile(
    fishProfile,
    "set -gx COPILOT_MODEL 'archestra/gpt-4o'\nset -gx COPILOT_PROVIDER_API_KEY 'arch_test'\nset -gx KEEP_ME 1\n",
  );
  const disconnect = COPILOT_GUARD_CLIENT.renderProxyDisconnect(
    buildStartupGuardContext(context),
  );
  const file = path.join(f.home, "disconnect.sh");
  await writeFile(file, `${disconnect}\ndisconnect_proxy\n`);
  await exec("bash", [file], { env: f.env });
  expect(await readFile(path.join(f.home, ".zshrc"), "utf8")).toBe(
    "export KEEP_ME=1\n",
  );
  expect(await readFile(fishProfile, "utf8")).toBe("set -gx KEEP_ME 1\n");
  expect(await json(f.registry)).toEqual(original);
  expect((await json(f.settings)).model).toBe("personal/local");
});

test("setup removes the provider exports an earlier setup left and warns about the live variables", async () => {
  const f = await fixture();
  await writeFile(
    path.join(f.home, ".zshrc"),
    "export COPILOT_PROVIDER_BASE_URL='https://proxy.example.com/v1/connection-setup/cps1_old/openai'\nexport COPILOT_PROVIDER_API_KEY='arch_old'\nexport COPILOT_MODEL='archestra/old'\nexport KEEP_ME=1\n",
  );
  await mkdir(path.join(f.home, ".config/fish/conf.d"), { recursive: true });
  const fishProfile = path.join(f.home, ".config/fish/conf.d/provider.fish");
  await writeFile(
    fishProfile,
    "set -gx COPILOT_MODEL 'archestra/old'\nset -gx COPILOT_PROVIDER_TYPE openai\nset -gx KEEP_ME 1\n",
  );
  const { stdout } = await f.run(context, {
    COPILOT_MODEL: "archestra/old",
    COPILOT_PROVIDER_BASE_URL:
      "https://proxy.example.com/v1/connection-setup/cps1_old/openai",
  });
  // .zshrc also gains the launch-check block; only the stale exports went.
  const zshrc = await readFile(path.join(f.home, ".zshrc"), "utf8");
  expect(zshrc).not.toContain("export COPILOT_");
  expect(zshrc).toContain("export KEEP_ME=1\n");
  expect(await readFile(fishProfile, "utf8")).toBe("set -gx KEEP_ME 1\n");
  expect(stdout).toContain(
    "Removed the COPILOT_PROVIDER_* and COPILOT_MODEL exports an earlier setup added to your shell profile",
  );
  expect(stdout).toContain(
    "still set in open terminals: COPILOT_MODEL COPILOT_PROVIDER_BASE_URL.",
  );
  expect(stdout).toContain(
    "Run: unset COPILOT_MODEL COPILOT_PROVIDER_BASE_URL",
  );
  // The script dropped the variables itself, so the closing note has nothing left to flag.
  expect(stdout).not.toContain("Set in this shell:");
  expect((await json(f.settings)).model).toBe("archestra/gpt-4o");
});

test("provider variables that are not ours are left alone and listed in the closing note", async () => {
  const f = await fixture();
  const ollama =
    "export COPILOT_MODEL='gpt-4o'\nexport COPILOT_PROVIDER_BASE_URL='http://localhost:11434/v1'\n";
  await writeFile(path.join(f.home, ".zshrc"), ollama);
  const { stdout } = await f.run(context, {
    COPILOT_MODEL: "gpt-4o",
    COPILOT_PROVIDER_BASE_URL: "http://localhost:11434/v1",
  });
  expect(await readFile(path.join(f.home, ".zshrc"), "utf8")).toContain(ollama);
  expect(stdout).not.toContain("Removed the COPILOT_PROVIDER_*");
  expect(stdout).toContain(
    "Set in this shell: COPILOT_MODEL, COPILOT_PROVIDER_BASE_URL. To remove them:",
  );
  expect(stdout).toContain("unset COPILOT_MODEL COPILOT_PROVIDER_BASE_URL");
  expect(stdout).toContain(
    "The launch check drops them while the LLM proxy is connected.",
  );
});

test("a provider without a Responses route keeps Copilot's default wire", async () => {
  const f = await fixture();
  const { stdout } = await f.run({
    ...context,
    proxy: {
      ...proxy,
      provider: "groq",
      providerLabel: "Groq",
      url: "https://proxy.example.com/v1/groq",
    },
  });
  const installed = await json(f.registry);
  expect(installed.providers[0]).not.toHaveProperty("wireApi");
  expect(stdout).not.toContain("COPILOT_PROVIDER_WIRE_API");
});

test("custom config paths are honored and missing credentials are not reported as installed", async () => {
  const f = await fixture();
  f.env.COPILOT_PROVIDERS_CONFIG = path.join(
    f.home,
    "custom registry",
    "providers.json",
  );
  const { stdout } = await f.run({
    ...context,
    proxy: { ...proxy, virtualKey: null, authMode: "provider-key" },
  });
  expect(
    (await json(f.env.COPILOT_PROVIDERS_CONFIG)).providers[0],
  ).not.toHaveProperty("apiKey");
  expect(stdout).toContain("No API key was available");
  expect(stdout).not.toContain(
    "Your provider settings and API key are already saved",
  );
});

test.each([
  "{invalid",
  '{"providers":{}}',
  '{"providers":[{"name":"archestra","baseUrl":"https://personal.example.com"}]}',
])("invalid or unowned registry is left untouched: %s", async (original) => {
  const f = await fixture();
  await writeFile(f.registry, original);
  await expect(f.run()).rejects.toThrow();
  expect(await readFile(f.registry, "utf8")).toBe(original);
});

test("disconnect preserves a model the user selected after setup", async () => {
  const f = await fixture();
  await f.run();
  await writeFile(f.settings, JSON.stringify({ model: "personal/local" }));
  await f.remove();
  expect((await json(f.settings)).model).toBe("personal/local");
  expect((await json(f.registry)).providers).toEqual([]);
});

test("PowerShell embeds the same executable writer and prints optional instructions after setup", async () => {
  const f = await fixture();
  const script = renderSetupScript({ ...context, platform: "windows" });
  // Run the actual embedded writer, with the inputs emitted by PowerShell.
  const source = script.match(/ {4}@'\n([\s\S]*?)\n'@ \| node/)?.[1];
  const config = script
    .match(/\$env:ARCHESTRA_COPILOT_CONFIG = '([^\n]*)'/)?.[1]
    .replace(/''/g, "'");
  expect(source).toBeDefined();
  const file = path.join(f.home, "windows-writer.cjs");
  await writeFile(file, source ?? "");
  await exec(process.execPath, [file], {
    env: {
      ...f.env,
      ARCHESTRA_COPILOT_ACTION: "install",
      ARCHESTRA_COPILOT_VERSION: "GitHub Copilot CLI 1.0.95",
      ARCHESTRA_COPILOT_CONFIG: config,
      ARCHESTRA_COPILOT_API_KEY: proxy.virtualKey,
    },
  });
  expect((await json(f.registry)).providers[0].apiKey).toBe(proxy.virtualKey);
  expect((await json(f.settings)).model).toBe("archestra/gpt-4o");
  const marker = script.match(/^# archestra-ending: (\S+)$/m)?.[1];
  const instructions = JSON.parse(
    Buffer.from(marker ?? "", "base64").toString("utf8"),
  ).optionalInstructions;
  expect(instructions).toBeDefined();
  // The closing note gives PowerShell commands for a COPILOT_MODEL still set.
  const { stdout } = await exec(process.execPath, ["-e", instructions ?? ""], {
    env: {
      ...f.env,
      ARCHESTRA_COPILOT_SHELL: "powershell",
      COPILOT_MODEL: "archestra/other",
    },
  });
  expect(stdout).toContain("Copilot starts with archestra/gpt-4o");
  expect(stdout).toContain("Set in this shell: COPILOT_MODEL. To remove it:");
  expect(stdout).toContain("Remove-Item Env:COPILOT_MODEL");
  expect(stdout).toContain(
    "[Environment]::SetEnvironmentVariable('COPILOT_MODEL', $null, 'User')",
  );
  expect(stdout).not.toContain("unset COPILOT_MODEL");
  // The PowerShell setup also clears the set an earlier setup persisted.
  expect(script).toContain("$archLegacyNames = @('COPILOT_MODEL', ");
  expect(script).toContain("-like '*/v1/connection-setup/*'");
  expect(script).toContain(
    "[Environment]::SetEnvironmentVariable($archName, $null, $archScope)",
  );
  expect(script.indexOf(instructions ?? "")).toBeGreaterThan(
    script.indexOf("Copilot CLI is connected"),
  );
});

test("older Copilot versions fail before changing provider files", async () => {
  const f = await fixture();
  await writeFile(
    path.join(f.home, "bin/copilot"),
    "#!/bin/sh\necho 'GitHub Copilot CLI 1.0.94'\n",
  );
  await expect(f.run()).rejects.toThrow(/1.0.95 or newer/);
  await expect(stat(f.registry)).rejects.toThrow();
});

test("fish gets its own unset command and a changed user model survives reconnect/disconnect", async () => {
  const f = await fixture();
  f.env.SHELL = "/usr/bin/fish";
  const { stdout } = await f.run(context, { COPILOT_MODEL: "gpt-4o" });
  expect(stdout).toContain("set -e COPILOT_MODEL");
  expect(stdout).not.toContain("unset COPILOT_MODEL");
  expect(stdout).not.toContain("export COPILOT_");
  await writeFile(f.settings, JSON.stringify({ model: "personal/new-model" }));
  await f.run();
  await f.remove();
  expect((await json(f.settings)).model).toBe("personal/new-model");
});

test("reconnecting does not replace a provider the user repurposed after setup", async () => {
  const f = await fixture();
  await f.run();
  const registry = await json(f.registry);
  registry.providers[0].baseUrl = "https://personal.example.com";
  const edited = JSON.stringify(registry);
  await writeFile(f.registry, edited);
  await expect(f.run()).rejects.toThrow(/changed outside setup/);
  expect(await readFile(f.registry, "utf8")).toBe(edited);
});
