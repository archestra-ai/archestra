import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse } from "smol-toml";
import { afterEach, expect, test } from "vitest";
import { F52_GROK_SKILLS } from "../../../test/fixtures/f52-marketplace-skills-sync";
import { GROK_SKILLS } from "../payloads/grok-skills";
import type { SetupScriptContext } from "../types";
import { grokSetup } from "./grok";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    rmSync(home, { recursive: true, force: true });
});

function fixture() {
  const home = mkdtempSync(path.join(tmpdir(), "grok-native-skills-"));
  homes.push(home);
  const native = path.join(home, ".grok"),
    root = path.join(home, ".archestra/grok"),
    remote = path.join(home, "remote"),
    bin = path.join(home, "bin");
  for (const directory of [native, root, remote, bin])
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  const binary = process.env.ARCHESTRA_GROK_TEST_BINARY;
  if (binary) symlinkSync(binary, path.join(bin, "grok"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", remote, ...args], {
      encoding: "utf8",
      stdio: "pipe",
    });
  git("init", "--quiet");
  const skill = path.join(remote, "plugins/team-skills/skills/sample");
  mkdirSync(path.join(skill, "references"), { recursive: true });
  mkdirSync(path.join(remote, "plugins/team-skills/.claude-plugin"), {
    recursive: true,
  });
  writeFileSync(
    path.join(remote, "plugins/team-skills/.claude-plugin/plugin.json"),
    JSON.stringify({
      name: "team-skills",
      version: "1.0.0",
      description: "Synthetic",
    }),
  );
  writeFileSync(
    path.join(skill, "SKILL.md"),
    "---\r\nname: sample\r\ndescription: Synthetic skill invocation\r\nuser-invocable: true\r\n---\r\nNATIVE_SKILL_INVOCATION_SENTINEL\r\nRead references/hooks-guide.md when needed.\r\n",
  );
  writeFileSync(
    path.join(skill, "references/hooks-guide.md"),
    "Passive resource, not an active client hook.\r\n",
  );
  mkdirSync(path.join(skill, "hooks"));
  writeFileSync(
    path.join(skill, "hooks/hooks.json"),
    '{"example":"passive skill resource"}\n',
  );
  const commit = () => {
    git("add", "-A");
    git(
      "-c",
      "user.name=Synthetic",
      "-c",
      "user.email=fixture@example.test",
      "commit",
      "--quiet",
      "-m",
      "synthetic",
    );
  };
  commit();
  const gitConfig = path.join(home, "gitconfig");
  writeFileSync(
    gitConfig,
    `[url "${remote}"]\n insteadOf = https://fixture.example/share/repo.git\n[protocol "file"]\n allow = always\n`,
  );
  const env = {
    ...process.env,
    HOME: home,
    GROK_HOME: native,
    PATH: bin + path.delimiter + process.env.PATH,
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GROK_DISABLE_AUTOUPDATER: "1",
    GROK_TELEMETRY_ENABLED: "0",
  };
  const source = {
    cloneUrl: "https://fixture.example/share/repo.git",
    marketplaceName: "team-skills",
    organizationId: "synthetic-org",
    hasSkills: true,
  };
  const sync = (selected: typeof source | null = source, legacy = false) =>
    spawnSync(
      process.execPath,
      [
        "-e",
        (legacy ? F52_GROK_SKILLS : GROK_SKILLS) +
          "\nsyncGrokSkills(" +
          JSON.stringify({
            source: selected,
            home: native,
            privateRoot: root,
            install: true,
          }) +
          ");",
      ],
      { env, encoding: "utf8" },
    );
  return { home, native, root, skill, env, source, commit, sync };
}

test("native skill lifecycle preserves passive hook-named resources, unmanaged skills, edits and failed sources", () => {
  const current = fixture(),
    destination = path.join(current.root, "native/skills/sample");
  const unmanaged = path.join(current.root, "native/skills/personal");
  mkdirSync(unmanaged, { recursive: true });
  writeFileSync(path.join(unmanaged, "SKILL.md"), "personal");
  expect(current.sync().status).toBe(0);
  expect(
    readFileSync(path.join(destination, "references/hooks-guide.md"), "utf8"),
  ).toContain("Passive resource");
  expect(current.sync().status).toBe(0);
  expect(current.sync().status).toBe(0);
  writeFileSync(
    path.join(current.skill, "references/hooks-guide.md"),
    "updated resource\r\n",
  );
  current.commit();
  expect(current.sync().status).toBe(0);
  expect(
    readFileSync(path.join(destination, "references/hooks-guide.md"), "utf8"),
  ).toBe("updated resource\r\n");
  writeFileSync(path.join(destination, "SKILL.md"), "user edit");
  const state = readFileSync(path.join(current.root, "native-skills.json"));
  expect(current.sync().status).not.toBe(0);
  expect(current.sync(null).status).not.toBe(0);
  expect(readFileSync(path.join(destination, "SKILL.md"), "utf8")).toBe(
    "user edit",
  );
  expect(readFileSync(path.join(current.root, "native-skills.json"))).toEqual(
    state,
  );
  writeFileSync(
    path.join(destination, "SKILL.md"),
    readFileSync(path.join(current.skill, "SKILL.md")),
  );
  expect(current.sync(null).status).toBe(0);
  expect(existsSync(destination)).toBe(false);
  expect(readFileSync(path.join(unmanaged, "SKILL.md"), "utf8")).toBe(
    "personal",
  );
});

test.each([
  "linked",
  "case-collision",
  "plugin-manifest",
  "plugin-request",
])("native skill %s refuses without overwriting unmanaged files", (kind) => {
  const current = fixture(),
    destination = path.join(current.root, "native/skills");
  mkdirSync(destination, { recursive: true });
  if (kind === "linked")
    symlinkSync(current.skill, path.join(destination, "sample"));
  if (kind === "case-collision") {
    mkdirSync(path.join(destination, "Sample"));
    writeFileSync(path.join(destination, "Sample/SKILL.md"), "user");
  }
  if (kind === "plugin-manifest") {
    mkdirSync(path.join(current.skill, ".grok-plugin"));
    writeFileSync(
      path.join(current.skill, ".grok-plugin/plugin.json"),
      '{"name":"not-a-standalone-skill","hooks":"hooks/hooks.json"}',
    );
    current.commit();
  }
  const result =
    kind === "plugin-request"
      ? spawnSync(
          process.execPath,
          [
            "-e",
            GROK_SKILLS +
              "\nsyncGrokSkills(" +
              JSON.stringify({
                source: { ...current.source, pluginNames: ["not-delivered"] },
                home: current.native,
                privateRoot: current.root,
                install: true,
              }) +
              ");",
          ],
          { env: current.env, encoding: "utf8" },
        )
      : current.sync();
  expect(result.status).not.toBe(0);
  expect(
    existsSync(path.join(current.native, "installed-plugins/registry.json")),
  ).toBe(false);
});

test.each([
  "skill-rename",
  "state-rename",
])("native skills recover interrupted %s without losing the previous generation", (stage) => {
  const current = fixture();
  expect(current.sync().status).toBe(0);
  const destination = path.join(
    current.root,
    "native/skills/sample/references/hooks-guide.md",
  );
  writeFileSync(
    path.join(current.skill, "references/hooks-guide.md"),
    "new managed revision\n",
  );
  current.commit();
  const preload = path.join(current.home, "fault.cjs");
  writeFileSync(
    preload,
    `const fs=require("node:fs"),original=fs.renameSync;let failed=false;fs.renameSync=function(from,to){if(!failed && ${stage === "skill-rename" ? 'to.endsWith("/skills/sample")' : 'to.endsWith("/native-skills.json")'}){failed=true;throw Error("synthetic rename failure");}return original.apply(this,arguments);};`,
  );
  const failed = spawnSync(
    process.execPath,
    [
      "-e",
      GROK_SKILLS +
        "\nsyncGrokSkills(" +
        JSON.stringify({
          source: current.source,
          home: current.native,
          privateRoot: current.root,
          install: true,
        }) +
        ");",
    ],
    {
      env: {
        ...current.env,
        NODE_OPTIONS: `--require=${JSON.stringify(preload)}`,
      },
      encoding: "utf8",
    },
  );
  expect(failed.status).not.toBe(0);
  expect(existsSync(path.join(current.root, "native-skills-update.json"))).toBe(
    true,
  );
  const recovered = current.sync();
  expect(recovered.status, recovered.stderr).toBe(0);
  expect(readFileSync(destination, "utf8")).toBe("new managed revision\n");
  expect(existsSync(path.join(current.root, "native-skills-update.json"))).toBe(
    false,
  );
});

test.skipIf(!process.env.ARCHESTRA_GROK_TEST_BINARY)(
  "real historical plugin delivery migrates to native skills without touching a foreign registry entry",
  () => {
    const current = fixture(),
      binary = process.env.ARCHESTRA_GROK_TEST_BINARY as string;
    const foreign = path.join(current.home, "foreign");
    mkdirSync(path.join(foreign, ".claude-plugin"), { recursive: true });
    writeFileSync(
      path.join(foreign, ".claude-plugin/plugin.json"),
      JSON.stringify({ name: "foreign-personal", version: "1.0.0" }),
    );
    execFileSync(binary, ["plugin", "install", foreign, "--trust"], {
      env: current.env,
      stdio: "pipe",
    });
    const registry = () =>
      JSON.parse(
        readFileSync(
          path.join(current.native, "installed-plugins/registry.json"),
          "utf8",
        ),
      ).repos;
    const before = registry();
    const old = current.sync(current.source, true);
    expect(old.status, old.stderr).toBe(0);
    expect(
      Object.values(registry()).some((entry: unknown) =>
        Object.hasOwn((entry as { plugins: object }).plugins, "team-skills"),
      ),
    ).toBe(true);
    const migrated = current.sync();
    expect(migrated.status, migrated.stderr).toBe(0);
    for (const [key, value] of Object.entries(before))
      expect(registry()[key]).toEqual(value);
    expect(
      Object.values(registry()).some((entry: unknown) =>
        Object.hasOwn((entry as { plugins: object }).plugins, "team-skills"),
      ),
    ).toBe(false);
    expect(current.sync().status).toBe(0);
    expect(current.sync().status).toBe(0);
    expect(current.sync(null).status).toBe(0);
    for (const [key, value] of Object.entries(before))
      expect(registry()[key]).toEqual(value);
  },
);

test
  .skipIf(!process.env.ARCHESTRA_GROK_TEST_BINARY)
  .each(["different-host", "different-port", "different-organization"])(
  "native skills migration preserves a recorded legacy %s scope across reconnect and disconnect",
  (scope) => {
    const current = fixture();
    const old = current.sync(current.source, true);
    expect(old.status, old.stderr).toBe(0);
    const preserved = new Map<string, Buffer>();
    const record = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) record(file);
        else if (entry.isFile()) preserved.set(file, readFileSync(file));
      }
    };
    record(current.native);
    record(path.join(current.home, ".archestra/skills"));
    preserved.set(
      path.join(current.root, "skills.json"),
      readFileSync(path.join(current.root, "skills.json")),
    );
    const selected = {
      ...current.source,
      cloneUrl:
        scope === "different-host"
          ? "https://another.example/share/repo.git"
          : scope === "different-port"
            ? "https://fixture.example:3300/share/repo.git"
            : current.source.cloneUrl,
      organizationId:
        scope === "different-organization"
          ? "another-org"
          : current.source.organizationId,
    };
    writeFileSync(
      current.env.GIT_CONFIG_GLOBAL,
      readFileSync(current.env.GIT_CONFIG_GLOBAL, "utf8") +
        `\n[url "${path.join(current.home, "remote")}"]\n insteadOf = ${selected.cloneUrl}\n`,
    );
    for (let iteration = 0; iteration < 3; iteration++) {
      const result = current.sync(selected);
      expect(result.status, result.stderr).toBe(0);
    }
    expect(
      readFileSync(
        path.join(current.root, "native/skills/sample/SKILL.md"),
        "utf8",
      ),
    ).toContain("NATIVE_SKILL_INVOCATION_SENTINEL");
    expect(current.sync(null).status).toBe(0);
    for (const [file, bytes] of preserved)
      expect(readFileSync(file)).toEqual(bytes);
  },
);

test
  .skipIf(!process.env.ARCHESTRA_GROK_TEST_BINARY)
  .each(["edited", "unowned"])(
  "legacy %s plugin remains untouched during native skills migration",
  (kind) => {
    const current = fixture();
    expect(current.sync(current.source, true).status).toBe(0);
    const stateFile = path.join(current.root, "skills.json");
    const ownership = JSON.parse(readFileSync(stateFile, "utf8"));
    const legacySkill = path.join(
      ownership.plugins["team-skills"].path,
      "skills/sample/SKILL.md",
    );
    if (kind === "edited")
      writeFileSync(legacySkill, "Preserve this local edit.\n");
    else unlinkSync(stateFile);
    const files = [
      legacySkill,
      path.join(current.native, "config.toml"),
      path.join(current.native, "installed-plugins/registry.json"),
    ];
    const before = files.map((file) => readFileSync(file));
    const result = current.sync();
    if (kind === "edited") expect(result.status).not.toBe(0);
    else expect(result.status, result.stderr).toBe(0);
    for (const [index, file] of files.entries())
      expect(readFileSync(file)).toEqual(before[index]);
    if (kind === "edited")
      expect(JSON.parse(readFileSync(stateFile, "utf8"))).toEqual(ownership);
    else expect(existsSync(stateFile)).toBe(false);
  },
);

test
  .skipIf(!process.env.ARCHESTRA_GROK_TEST_BINARY)
  .each([
    "config-write",
    "scope-write",
    "state-write",
    "removed-checkpoint",
    "journal-cleanup",
  ])(
  "successful legacy uninstall recovers after %s failure without replacing concurrent foreign registrations",
  (stage) => {
    const current = fixture();
    expect(current.sync(current.source, true).status).toBe(0);
    const config = path.join(current.native, "config.toml");
    writeFileSync(
      config,
      readFileSync(config, "utf8") +
        '\n[plugins.user]\napi_key="synthetic-user-value"\n[preferences]\ncolor="blue"\n',
    );
    const fault = path.join(current.home, "removal-fault.cjs");
    writeFileSync(
      fault,
      `const fs=require("node:fs"),original=fs.renameSync,unlink=fs.unlinkSync;let failed=false,journals=0;fs.renameSync=function(from,to){if(to.endsWith("/legacy-plugin-removal.json"))journals++;if(!failed&&${stage === "config-write" ? `to===${JSON.stringify(config)}` : stage === "state-write" ? 'to.endsWith("/skills.json")' : stage === "removed-checkpoint" ? 'to.endsWith("/legacy-plugin-removal.json")&&journals===2' : stage === "scope-write" ? 'to.includes("/skill-scopes/")' : "false"}){failed=true;throw Error("synthetic commit failure");}return original.apply(this,arguments);};${stage === "journal-cleanup" ? 'fs.unlinkSync=function(file){if(!failed&&file.endsWith("/legacy-plugin-removal.json")){failed=true;throw Error("synthetic journal cleanup failure");}return unlink.apply(this,arguments);};' : ""}`,
    );
    const failSync = (selected: typeof current.source | null) =>
      spawnSync(
        process.execPath,
        [
          "-e",
          GROK_SKILLS +
            "\nsyncGrokSkills(" +
            JSON.stringify({
              source: selected,
              home: current.native,
              privateRoot: current.root,
              install: true,
            }) +
            ");",
        ],
        {
          env: {
            ...current.env,
            NODE_OPTIONS: `--require=${JSON.stringify(fault)}`,
          },
          encoding: "utf8",
        },
      );
    expect(failSync(current.source).status).not.toBe(0);
    const foreign = path.join(current.home, "concurrent-foreign");
    mkdirSync(path.join(foreign, ".claude-plugin"), { recursive: true });
    writeFileSync(
      path.join(foreign, ".claude-plugin/plugin.json"),
      JSON.stringify({ name: "concurrent-foreign", version: "1.0.0" }),
    );
    execFileSync(
      process.env.ARCHESTRA_GROK_TEST_BINARY as string,
      ["plugin", "install", foreign, "--trust"],
      { env: current.env, stdio: "pipe" },
    );
    const registryFile = path.join(
      current.native,
      "installed-plugins/registry.json",
    );
    const registry = JSON.parse(readFileSync(registryFile, "utf8")).repos;
    const foreignEntries = Object.entries(registry).filter(([, entry]) =>
      Object.hasOwn(
        (entry as { plugins: object }).plugins,
        "concurrent-foreign",
      ),
    );
    expect(foreignEntries).toHaveLength(1);
    if (stage === "scope-write") expect(failSync(null).status).not.toBe(0);
    const recovered =
      stage === "scope-write" ? current.sync(null) : current.sync();
    expect(recovered.status, recovered.stderr).toBe(0);
    expect(current.sync().status).toBe(0);
    const finalRegistry = JSON.parse(readFileSync(registryFile, "utf8")).repos;
    for (const [key, value] of foreignEntries)
      expect(finalRegistry[key]).toEqual(value);
    expect(
      JSON.parse(readFileSync(path.join(current.root, "skills.json"), "utf8"))
        .plugins,
    ).toEqual({});
    expect(
      JSON.parse(readFileSync(path.join(current.root, "skills.json"), "utf8"))
        .source,
    ).toBeNull();
    expect(parse(readFileSync(config, "utf8"))).toMatchObject({
      plugins: { user: { api_key: "synthetic-user-value" } },
      preferences: { color: "blue" },
    });
    expect(
      existsSync(path.join(current.root, "legacy-plugin-removal.json")),
    ).toBe(false);
  },
);

test
  .skipIf(!process.env.ARCHESTRA_GROK_TEST_BINARY)
  .each([
    "failure-truncate",
    "failure-remove",
    "success-drop-unrelated",
    "success-add-unrelated",
  ])(
  "legacy removal %s preserves unrelated config and private ownership",
  (mode) => {
    const current = fixture(),
      binary = process.env.ARCHESTRA_GROK_TEST_BINARY as string;
    expect(current.sync(current.source, true).status).toBe(0);
    const config = path.join(current.native, "config.toml");
    const before =
      readFileSync(config, "utf8") +
      '\n[plugins.user]\napi_key="synthetic-user-value"\n\n[preferences]\ncolor="blue"\n';
    writeFileSync(config, before);
    const stateFile = path.join(current.root, "skills.json"),
      ownership = readFileSync(stateFile);
    const wrapper = path.join(current.home, "bin/grok");
    unlinkSync(wrapper);
    writeFileSync(
      wrapper,
      `#!${process.execPath}\nconst fs=require("node:fs"),path=require("node:path"),args=process.argv.slice(2),file=path.join(process.env.GROK_HOME,"config.toml");
if(args[0]!=="plugin"||args[1]!=="uninstall")throw Error("No plugin installation is permitted");
${mode.startsWith("success") ? `const result=require("node:child_process").spawnSync(${JSON.stringify(binary)},args,{stdio:"ignore"});if(result.status!==0)process.exit(1);${mode === "success-drop-unrelated" ? 'fs.writeFileSync(file,"[plugins]\\nenabled=[]\\n");' : 'fs.appendFileSync(file,"\\n[plugins.concurrent]\\nvalue=\\"preserve-new-entry\\"\\n");'}` : mode === "failure-remove" ? "fs.unlinkSync(file);process.exit(1);" : 'fs.writeFileSync(file, "");process.exit(1);'}\n`,
      { mode: 0o700 },
    );
    const result = current.sync();
    if (mode.startsWith("failure")) {
      expect(result.status).not.toBe(0);
      expect(readFileSync(stateFile)).toEqual(ownership);
      expect(readFileSync(config, "utf8")).toBe(before);
    } else {
      expect(result.status, result.stderr).toBe(0);
      expect(parse(readFileSync(config, "utf8"))).toMatchObject({
        plugins: { user: { api_key: "synthetic-user-value" } },
        preferences: { color: "blue" },
      });
      if (mode === "success-add-unrelated")
        expect(parse(readFileSync(config, "utf8"))).toMatchObject({
          plugins: { concurrent: { value: "preserve-new-entry" } },
        });
    }
  },
);

test.skipIf(!process.env.ARCHESTRA_GROK_TEST_BINARY)(
  "real native skill invocation uses dedicated GROK_HOME, not the registered ambient Claude plugin",
  async () => {
    const current = fixture(),
      binary = process.env.ARCHESTRA_GROK_TEST_BINARY as string;
    const bodies: string[] = [];
    const server = createServer(async (request, response) => {
      if (request.method !== "POST") {
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify({
            data: [
              {
                id: "synthetic",
                model: "synthetic",
                api_backend: "chat_completions",
              },
            ],
          }),
        );
        return;
      }
      let body = "";
      for await (const chunk of request) body += chunk;
      bodies.push(body);
      response.setHeader("Content-Type", "text/event-stream");
      response.end(
        'data: {"id":"synthetic","object":"chat.completion.chunk","created":1,"model":"synthetic","choices":[{"index":0,"delta":{"role":"assistant","content":"Synthetic skill completed."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing synthetic server");
    const base = `http://127.0.0.1:${address.port}/v1`;
    const original = `[models]\ndefault="synthetic"\n[model.synthetic]\nmodel="synthetic"\nbase_url=${JSON.stringify(base)}\napi_key="synthetic"\n`;
    writeFileSync(path.join(current.native, "config.toml"), original);
    const ambient = path.join(
        current.home,
        ".claude/plugins/cache/synthetic/ambient/1.0.0",
      ),
      counter = path.join(current.home, "hook-counter");
    mkdirSync(path.join(ambient, ".claude-plugin"), { recursive: true });
    mkdirSync(path.join(ambient, "hooks"));
    writeFileSync(
      path.join(ambient, ".claude-plugin/plugin.json"),
      JSON.stringify({ name: "ambient-registered", version: "1.0.0" }),
    );
    mkdirSync(path.join(ambient, "skills/ambient"), { recursive: true });
    writeFileSync(
      path.join(ambient, "skills/ambient/SKILL.md"),
      "---\nname: ambient\ndescription: AMBIENT_OTHER_CLIENT_CONTEXT\n---\nDo not load this in a managed session.\n",
    );
    const command =
      process.execPath +
      " " +
      JSON.stringify(path.join(current.home, "hook.cjs"));
    writeFileSync(
      path.join(current.home, "hook.cjs"),
      `require("node:fs").appendFileSync(${JSON.stringify(counter)},"ran\\n"); console.log(JSON.stringify({hookSpecificOutput:{hookEventName:"UserPromptSubmit",additionalContext:"AMBIENT_OTHER_CLIENT_CONTEXT"}}));`,
    );
    writeFileSync(
      path.join(ambient, "hooks/hooks.json"),
      JSON.stringify({
        hooks: Object.fromEntries(
          ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse"].map(
            (event) => [event, [{ hooks: [{ type: "command", command }] }]],
          ),
        ),
      }),
    );
    execFileSync(binary, ["plugin", "install", ambient, "--trust"], {
      env: current.env,
      stdio: "pipe",
    });
    execFileSync(binary, ["plugin", "enable", "ambient-registered"], {
      env: current.env,
      stdio: "pipe",
    });
    const baselineRegistry = readFileSync(
      path.join(current.native, "installed-plugins/registry.json"),
    );
    const run = (command: string, args: string[]) =>
      new Promise<{ status: number | null; stdout: string; stderr: string }>(
        (resolve, reject) => {
          const child = spawn(command, args, {
            env: current.env,
            cwd: current.home,
            stdio: ["ignore", "pipe", "pipe"],
          });
          let stdout = "",
            stderr = "";
          child.stdout.on("data", (chunk) => (stdout += chunk));
          child.stderr.on("data", (chunk) => (stderr += chunk));
          const timer = setTimeout(() => child.kill("SIGTERM"), 30000);
          child.on("error", reject);
          child.on("close", (status) => {
            clearTimeout(timer);
            resolve({ status, stdout, stderr });
          });
        },
      );
    try {
      expect(
        (
          await run(binary, [
            "-p",
            "Baseline synthetic fixture.",
            "--max-turns",
            "1",
            "--no-subagents",
          ])
        ).status,
      ).toBe(0);
      expect(existsSync(counter)).toBe(true);
      const count = readFileSync(counter, "utf8");
      expect(
        bodies.some((body) => body.includes("AMBIENT_OTHER_CLIENT_CONTEXT")),
      ).toBe(true);
      const baselineConfig = readFileSync(
        path.join(current.native, "config.toml"),
      );
      const context: SetupScriptContext = {
        clientId: "grok-build",
        platform: "windows",
        appName: "Synthetic",
        skills: current.source,
        mcp: null,
        proxy: {
          provider: "xai",
          providerLabel: "xAI",
          baseUrl: base,
          url: base,
          authMode: "virtual-key",
          virtualKey: "synthetic",
          passthroughVirtualKey: null,
          virtualKeyName: "synthetic",
          proxyName: "synthetic",
          model: "synthetic",
        },
      };
      const payload = grokSetup.powerShell.sections(context).join("\n"),
        encoded = /\$archNodeScript = '([^']+)'/.exec(payload)?.[1];
      expect(encoded).toBeTruthy();
      const program = Buffer.from(encoded as string, "base64").toString();
      const setup = path.join(current.home, "windows-node-setup.cjs");
      writeFileSync(setup, program, { mode: 0o600 });
      const installed = await run(process.execPath, [setup]);
      expect(installed.status, installed.stderr).toBe(0);
      const launcher = path.join(current.root, "launch.cjs"),
        first = bodies.length;
      const managed = await run(process.execPath, [
        launcher,
        "-p",
        "/user:sample",
        "--output-format",
        "json",
        "--max-turns",
        "1",
      ]);
      expect(managed.status, managed.stderr).toBe(0);
      expect(() => JSON.parse(managed.stdout)).not.toThrow();
      expect(
        bodies
          .slice(first)
          .some((body) => body.includes("NATIVE_SKILL_INVOCATION_SENTINEL")),
      ).toBe(true);
      expect(
        bodies
          .slice(first)
          .some((body) => body.includes("AMBIENT_OTHER_CLIENT_CONTEXT")),
      ).toBe(false);
      expect(readFileSync(counter, "utf8")).toBe(count);
      expect(
        readFileSync(
          path.join(current.native, "installed-plugins/registry.json"),
        ),
      ).toEqual(baselineRegistry);
      const afterSetupConfig = readFileSync(
        path.join(current.native, "config.toml"),
      );
      expect(afterSetupConfig).toEqual(baselineConfig);
      const concurrent = await Promise.all([
        run(binary, [
          "-p",
          "Bare concurrent fixture",
          "--max-turns",
          "1",
          "--no-subagents",
        ]),
        run(process.execPath, [
          launcher,
          "-p",
          "/user:sample",
          "--max-turns",
          "1",
        ]),
      ]);
      for (const result of concurrent)
        expect(result.status, result.stderr).toBe(0);
      expect(readFileSync(path.join(current.native, "config.toml"))).toEqual(
        afterSetupConfig,
      );
      expect(baselineConfig.toString()).toContain("ambient-registered");
      expect((await run(process.execPath, [launcher, "--sync"])).status).toBe(
        0,
      );
      expect((await run(process.execPath, [setup])).status).toBe(0);
      expect((await run(process.execPath, [setup])).status).toBe(0);
      expect(
        (
          await run(process.execPath, [
            path.join(current.root, "disconnect.cjs"),
          ])
        ).status,
      ).toBe(0);
      expect(
        readFileSync(
          path.join(current.native, "installed-plugins/registry.json"),
        ),
      ).toEqual(baselineRegistry);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
  90000,
);
