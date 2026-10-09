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
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { SetupScriptContext } from "../types";
import { renderDroidSetupScript } from "./droid";

const exec = promisify(execFile);
const proxy = {
  authMode: "virtual-key",
  provider: "anthropic",
  providerLabel: "Anthropic",
  baseUrl: "https://example.test/v1",
  url: "https://example.test/v1/anthropic/my-proxy",
  proxyName: "my-proxy",
  virtualKey: "arch_test_key",
  virtualKeyName: "Droid connection",
  passthroughVirtualKey: null,
  model: "claude-sonnet-4-5-20250929",
} as const;
const context: SetupScriptContext = {
  clientId: "droid",
  platform: "macos",
  appName: "Example Platform",
  mcp: {
    serverName: "new-gateway",
    legacyServerNames: ["old-gateway"],
    url: "https://example.test/v1/mcp/my-gateway",
    toolPrefix: "archestra__",
  },
  proxy,
  skills: null,
};

describe("Droid installer", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), "archestra-droid-test-"));
    await mkdir(path.join(home, ".factory"));
    await mkdir(path.join(home, "bin"));
    await writeFile(path.join(home, "bin/droid"), "#!/bin/sh\nexit 0\n");
    await chmod(path.join(home, "bin/droid"), 0o755);
  });
  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });
  const configPath = (home: string, name: string) =>
    path.join(home, ".factory", name);
  const json = async (file: string) => JSON.parse(await readFile(file, "utf8"));
  const seed = (home: string, name: string, value: unknown) =>
    writeFile(configPath(home, name), JSON.stringify(value));
  function run(ctx = context, env: Record<string, string> = {}) {
    return exec("bash", ["-c", renderDroidSetupScript(ctx)], {
      cwd: home,
      env: {
        ...process.env,
        HOME: home,
        FACTORY_HOME_OVERRIDE: "",
        PATH: `${home}/bin:${process.env.PATH}`,
        ANTHROPIC_API_KEY: "",
        OPENAI_API_KEY: "",
        ZAI_API_KEY: "",
        ZHIPU_API_KEY: "",
        MINIMAX_API_KEY: "",
        KIMI_API_KEY: "",
        MOONSHOT_API_KEY: "",
        ...env,
      },
    });
  }

  test("merges the gateway and model, preserves user settings, and reruns without overwriting backups", async () => {
    const original = {
      theme: "dark",
      customModels: [
        {
          model: "local",
          provider: "openai",
          apiKey: "local-key",
          baseUrl: "http://localhost:1234/v1",
        },
      ],
      sessionDefaultSettings: {
        model: "original-model",
        specModeModel: "original-spec",
        autonomyLevel: "off",
      },
      subagentModelSettings: { lightModel: "explicit-choice" },
    };
    await seed(home, "settings.json", original);
    await seed(home, "mcp.json", {
      mcpServers: {
        "old-gateway": { type: "http", url: context.mcp?.url },
        unrelated: { command: "my-server" },
      },
    });
    await run();
    const settings = await json(configPath(home, "settings.json"));
    expect(settings.customModels).toHaveLength(2);
    expect(settings.customModels[0]).toEqual(original.customModels[0]);
    expect(settings.customModels[1]).toMatchObject({
      id: "custom:archestra-my-proxy",
      provider: "anthropic",
      baseUrl: proxy.url,
      apiKey: proxy.virtualKey,
      extraHeaders: { "X-Archestra-Agent-Id": "droid" },
    });
    expect(settings.sessionDefaultSettings).toEqual({
      model: "custom:archestra-my-proxy",
      specModeModel: "custom:archestra-my-proxy",
      autonomyLevel: "off",
    });
    expect(settings.subagentModelSettings).toEqual(
      original.subagentModelSettings,
    );
    const mcp = await json(configPath(home, "mcp.json"));
    expect(mcp.mcpServers).toEqual({
      unrelated: { command: "my-server" },
      "new-gateway": { type: "http", url: context.mcp?.url, disabled: false },
    });
    await run();
    expect(await json(configPath(home, "settings.json"))).toEqual(settings);
    expect(
      await json(configPath(home, "settings.json.archestra-backup")),
    ).toEqual(original);
    expect((await stat(configPath(home, "settings.json"))).mode & 0o777).toBe(
      0o600,
    );
    const state = await json(
      path.join(home, ".archestra/droid-connection-state.json"),
    );
    expect(state.connections["custom:archestra-my-proxy"]).toMatchObject({
      model: "original-model",
      specModel: "original-spec",
    });
  });

  test("uses matching BYOK credentials and rejects a virtual key when switching to provider auth", async () => {
    const local = {
      model: proxy.model,
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: Droid expands this credential reference at launch.
      apiKey: "${MY_ANTHROPIC_KEY}",
    };
    await seed(home, "settings.json", { customModels: [local] });
    const passthrough: SetupScriptContext = {
      ...context,
      proxy: { ...proxy, authMode: "provider-key", virtualKey: null },
    };
    await run(passthrough);
    expect(
      (await json(configPath(home, "settings.json"))).customModels[1].apiKey,
    ).toBe(local.apiKey);
    await run();
    // Remove the independent local model; our virtual key must never become
    // the upstream provider key on the next provider-auth run.
    const settings = await json(configPath(home, "settings.json"));
    settings.customModels.shift();
    await seed(home, "settings.json", settings);
    await expect(run(passthrough)).rejects.toThrow("Set ANTHROPIC_API_KEY");
    await run(passthrough, { ANTHROPIC_API_KEY: "provider-key" });
    expect(
      (await json(configPath(home, "settings.json"))).customModels[0].apiKey,
    ).toBe("provider-key");
  });

  test("routes OpenAI Responses and compatible Chat Completions with the correct base URL", async () => {
    for (const provider of [
      "openai",
      "groq",
      "zhipuai",
      "minimax",
      "kimi",
    ] as const) {
      await run({
        ...context,
        proxy: {
          ...proxy,
          provider,
          model: "test-model",
          url: `https://example.test/v1/${provider}/my-proxy`,
        },
      });
      const entry = (await json(configPath(home, "settings.json")))
        .customModels[0];
      expect(entry.provider).toBe(
        provider === "openai" ? "openai" : "generic-chat-completion-api",
      );
      expect(entry.baseUrl).toBe(
        `https://example.test/v1/${provider}/my-proxy`,
      );
      expect(entry.model).toBe("test-model");
      expect(entry.apiKey).toBe(proxy.virtualKey);
    }
  });

  test.each([
    "ZAI_API_KEY",
    "ZHIPU_API_KEY",
  ])("routes Zhipu through the proxy using the local %s credential", async (credentialEnv) => {
    await run(
      {
        ...context,
        proxy: {
          ...proxy,
          provider: "zhipuai",
          model: "glm-5.1",
          authMode: "provider-key",
          virtualKey: null,
          url: "https://example.test/v1/zhipuai/my-proxy",
        },
      },
      { [credentialEnv]: "zhipu-provider-key" },
    );
    expect(
      (await json(configPath(home, "settings.json"))).customModels[0],
    ).toMatchObject({
      model: "glm-5.1",
      provider: "generic-chat-completion-api",
      baseUrl: "https://example.test/v1/zhipuai/my-proxy",
      apiKey: "zhipu-provider-key",
    });
  });

  test("fails on invalid JSON without writing the other config or exposing its contents", async () => {
    const invalid = '{"secret":"do-not-print",';
    await writeFile(configPath(home, "settings.json"), invalid);
    await expect(run()).rejects.toThrow("Invalid JSON in");
    expect(await readFile(configPath(home, "settings.json"), "utf8")).toBe(
      invalid,
    );
    await expect(stat(configPath(home, "mcp.json"))).rejects.toThrow();
    try {
      await run();
    } catch (error) {
      expect(String(error)).not.toContain("do-not-print");
    }
  });

  test("excluded sections do not create or alter configuration", async () => {
    await run({ ...context, proxy: null });
    await expect(stat(configPath(home, "settings.json"))).rejects.toThrow();
    const mcp = await readFile(configPath(home, "mcp.json"), "utf8");
    await run({ ...context, mcp: null });
    expect(await readFile(configPath(home, "mcp.json"), "utf8")).toBe(mcp);
  });

  test("keeps provider credentials separate when switching between compatible providers", async () => {
    const passthrough: SetupScriptContext = {
      ...context,
      proxy: {
        ...proxy,
        provider: "groq",
        authMode: "provider-key",
        virtualKey: null,
        model: "shared-model",
        url: "https://example.test/v1/groq",
      },
    };
    await run(passthrough, { GROQ_API_KEY: "groq-only" });
    await expect(
      run(
        {
          ...passthrough,
          proxy: {
            ...proxy,
            authMode: "provider-key",
            virtualKey: null,
            model: "shared-model",
            provider: "openrouter",
            url: "https://example.test/v1/openrouter",
          },
        },
        { OPENROUTER_API_KEY: "" },
      ),
    ).rejects.toThrow("Set OPENROUTER_API_KEY");
  });

  test("stores enabled runtime handoff instructions in a discoverable skill", async () => {
    await run({
      ...context,
      runtimeHandoffInstructions: "Use the gateway to delegate this task.",
    });
    const skill = await readFile(
      path.join(home, ".factory/skills/archestra-runtime-handoff/SKILL.md"),
      "utf8",
    );
    expect(skill).toContain("name: archestra-runtime-handoff\n");
    expect(skill).toContain(context.mcp?.url);
    expect(skill).toContain("Use the gateway to delegate this task.");
    expect(skill).not.toContain(proxy.virtualKey);
  });

  test("refreshes an expiring skills share URL while refusing an unrelated repository", async () => {
    const folder = path.join(home, ".factory/skills/example-skills");
    await mkdir(path.join(folder, ".git"), { recursive: true });
    const oldUrl = path.join(home, "git-origin");
    const log = path.join(home, "git-log");
    await writeFile(
      oldUrl,
      "https://example.test/skills/expired-share/repo.git\n",
    );
    const git = path.join(home, "bin/git");
    await writeFile(
      git,
      `#!/bin/sh\nif [ "$3" = "remote" ] && [ "$4" = "get-url" ]; then cat '${oldUrl}'; else printf '%s\\n' "$@" >> '${log}'; fi\n`,
    );
    await chmod(git, 0o755);
    const ctx: SetupScriptContext = {
      ...context,
      skills: {
        cloneUrl: "https://example.test/skills/fresh-share/repo.git",
        marketplaceName: "example-skills",
      },
    };
    await run(ctx);
    expect(await readFile(log, "utf8")).toContain(
      "set-url\norigin\nhttps://example.test/skills/fresh-share/repo.git",
    );
    await writeFile(oldUrl, "https://unrelated.test/skills/repo.git\n");
    await expect(run(ctx)).rejects.toThrow("belongs to another repository");
  });

  test("installs complete skill directories and updates the clone on a second run", async () => {
    const repository = path.join(home, "marketplace");
    await mkdir(path.join(repository, "skills/review/scripts"), {
      recursive: true,
    });
    await writeFile(
      path.join(repository, "skills/review/SKILL.md"),
      "---\nname: review\ndescription: Review changes\n---\nReview the changes.\n",
    );
    await writeFile(
      path.join(repository, "skills/review/scripts/check.sh"),
      "echo first\n",
    );
    await exec("git", ["init", "-q", repository]);
    await exec("git", ["-C", repository, "add", "."]);
    const commit = () =>
      exec("git", [
        "-C",
        repository,
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.test",
        "commit",
        "-qm",
        "Skill update",
      ]);
    await commit();
    const ctx: SetupScriptContext = {
      ...context,
      skills: { cloneUrl: repository, marketplaceName: "example-skills" },
    };
    await run(ctx);
    const installed = path.join(
      home,
      ".factory/skills/example-skills/skills/review/scripts/check.sh",
    );
    expect(await readFile(installed, "utf8")).toBe("echo first\n");
    await writeFile(
      path.join(repository, "skills/review/scripts/check.sh"),
      "echo updated\n",
    );
    await exec("git", ["-C", repository, "add", "."]);
    await commit();
    await run(ctx);
    expect(await readFile(installed, "utf8")).toBe("echo updated\n");
  });
});
