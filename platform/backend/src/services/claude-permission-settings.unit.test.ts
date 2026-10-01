import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { renderClaudePermissionSettingsScript } from "./claude-permission-settings";

const temporaryDirectories: string[] = [];
const credential = "synthetic-test-credential-do-not-print";

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Claude permission settings script", () => {
  test("changes only owned fields and restores the original baseline after repeated connects", () => {
    const fixture = createFixture();
    const original = {
      permissions: {
        defaultMode: "plan",
        allow: ["Read", "Bash(git status)"],
        ask: ["Bash(git push)"],
        deny: ["Read(.env)"],
        additionalDirectories: ["../project"],
        unknownPermission: { enabled: false },
      },
      disableAutoMode: "enable",
      env: { ANTHROPIC_API_KEY: credential, CUSTOM_VALUE: "keep" },
      unknownSetting: [1, { nested: true }],
    };
    writeJson(fixture.settingsFile, original);
    const originalBytes = readFileSync(fixture.settingsFile);
    const fullBackup = `${fixture.settingsFile}.archestra-backup`;

    expectSuccess(fixture.run("connect"));
    expect(readFileSync(fullBackup)).toEqual(originalBytes);
    expect(readJson(fixture.settingsFile)).toEqual({
      ...original,
      permissions: { ...original.permissions, defaultMode: "acceptEdits" },
      disableAutoMode: "disable",
    });
    expect(readJson(fixture.stateFile)).toMatchObject({
      settingsFile: realpathSync(fixture.settingsFile),
      permissionsPresent: true,
      defaultMode: { present: true, value: "plan" },
      disableAutoMode: { present: true, value: "enable" },
    });
    const firstBackup = readFileSync(fixture.stateFile, "utf8");
    expect(firstBackup).not.toContain(credential);
    expect(firstBackup).not.toContain("unknownSetting");

    expectSuccess(fixture.run("connect"));
    expect(readFileSync(fixture.stateFile, "utf8")).toBe(firstBackup);
    expect(readFileSync(fullBackup)).toEqual(originalBytes);
    expectSuccess(fixture.run("disconnect"));
    expect(readJson(fixture.settingsFile)).toEqual(original);
    expect(existsSync(fixture.stateFile)).toBe(false);

    const restored = readFileSync(fixture.settingsFile, "utf8");
    expectSuccess(fixture.run("disconnect"));
    expect(readFileSync(fixture.settingsFile, "utf8")).toBe(restored);
  });

  test("creates missing settings and removes only the permissions container it created", () => {
    for (const original of [undefined, { env: { CUSTOM_VALUE: "keep" } }]) {
      const fixture = createFixture();
      if (original) writeJson(fixture.settingsFile, original);

      expectSuccess(fixture.run("connect"));
      expect(readJson(fixture.settingsFile)).toEqual({
        ...original,
        permissions: { defaultMode: "acceptEdits" },
        disableAutoMode: "disable",
      });
      expect(readJson(fixture.stateFile)).toMatchObject({
        permissionsPresent: false,
        defaultMode: { present: false },
        disableAutoMode: { present: false },
      });
      expectSuccess(fixture.run("disconnect"));
      expect(readJson(fixture.settingsFile)).toEqual(original ?? {});
      expect(existsSync(fixture.stateFile)).toBe(false);
    }
  });

  test("retains preexisting empty permissions and owned values already matching the installed mode", () => {
    for (const original of [
      { permissions: {} },
      {
        permissions: { defaultMode: "acceptEdits" },
        disableAutoMode: "disable",
      },
    ]) {
      const fixture = createFixture();
      writeJson(fixture.settingsFile, original);

      expectSuccess(fixture.run("connect"));
      expectSuccess(fixture.run("disconnect"));
      expect(readJson(fixture.settingsFile)).toEqual(original);
      expect(existsSync(fixture.stateFile)).toBe(false);
    }
  });

  test("restores each owned field independently while preserving later user edits and deletions", () => {
    for (const edited of [
      { permissions: { defaultMode: "dontAsk" }, disableAutoMode: "disable" },
      {
        permissions: { defaultMode: "acceptEdits" },
        disableAutoMode: "enable",
      },
      { permissions: {} },
    ]) {
      const fixture = createFixture();
      writeJson(fixture.settingsFile, {
        disableAutoMode: "original-auto-mode",
      });
      expectSuccess(fixture.run("connect"));
      const laterSettings = {
        ...edited,
        permissions: { ...edited.permissions, deny: ["Read(private.txt)"] },
        env: { CUSTOM_VALUE: "added-later" },
      };
      writeJson(fixture.settingsFile, laterSettings);

      expectSuccess(fixture.run("disconnect"));
      const { defaultMode, ...otherPermissions } = laterSettings.permissions;
      expect(readJson(fixture.settingsFile)).toEqual({
        ...laterSettings,
        permissions:
          defaultMode === "acceptEdits"
            ? otherPermissions
            : laterSettings.permissions,
        ...(edited.disableAutoMode === "disable"
          ? { disableAutoMode: "original-auto-mode" }
          : {}),
      });
      expect(existsSync(fixture.stateFile)).toBe(false);
    }
  });

  test("reconnect captures changed owned values and container presence as the new baseline", () => {
    const fixture = createFixture();
    writeJson(fixture.settingsFile, {
      permissions: { defaultMode: "plan" },
      disableAutoMode: "enable",
    });
    expectSuccess(fixture.run("connect"));
    const updated = {
      permissions: { defaultMode: "default", ask: ["Bash(*)"] },
      disableAutoMode: "user-selected-mode",
    };
    writeJson(fixture.settingsFile, updated);
    expectSuccess(fixture.run("connect"));
    expect(readJson(fixture.stateFile)).toMatchObject({
      defaultMode: { present: true, value: "default" },
      disableAutoMode: { present: true, value: "user-selected-mode" },
    });
    expectSuccess(fixture.run("disconnect"));
    expect(readJson(fixture.settingsFile)).toEqual(updated);

    expectSuccess(fixture.run("connect"));
    writeJson(fixture.settingsFile, { unknownSetting: "keep" });
    expectSuccess(fixture.run("connect"));
    expectSuccess(fixture.run("disconnect"));
    expect(readJson(fixture.settingsFile)).toEqual({ unknownSetting: "keep" });
  });

  test("transfers ownership on reconnect without losing the baseline or allowing the old proxy to disconnect", () => {
    const fixture = createFixture();
    const firstProxy = "https://proxy-a.example.test/v1/anthropic";
    const secondProxy = "https://proxy-b.example.test/v1/anthropic";
    const original = {
      permissions: { defaultMode: "plan", deny: ["Read(private.txt)"] },
      disableAutoMode: "enable",
      env: { ANTHROPIC_API_KEY: credential },
    };
    writeJson(fixture.settingsFile, original);
    expectSuccess(fixture.run("connect", firstProxy));
    const firstState = readJson(fixture.stateFile);
    expect(firstState.owner).toBe(firstProxy);
    const fullBackup = readFileSync(`${fixture.settingsFile}.archestra-backup`);

    expectSuccess(fixture.run("connect", secondProxy));
    expect(readJson(fixture.stateFile)).toEqual({
      ...firstState,
      owner: secondProxy,
    });
    expect(readFileSync(`${fixture.settingsFile}.archestra-backup`)).toEqual(
      fullBackup,
    );
    const settings = readFileSync(fixture.settingsFile);
    const state = readFileSync(fixture.stateFile);

    expectSafeFailure(fixture.run("disconnect", firstProxy));
    expect(readFileSync(fixture.settingsFile)).toEqual(settings);
    expect(readFileSync(fixture.stateFile)).toEqual(state);
    expectSuccess(fixture.run("disconnect", secondProxy));
    expect(readJson(fixture.settingsFile)).toEqual(original);
    expect(existsSync(fixture.stateFile)).toBe(false);
  });

  test("verification rejects a leftover mode backup and succeeds after restoration while preserving the user's mode edit", () => {
    const fixture = createFixture();
    const owner = "https://proxy.example.test/v1/anthropic";
    writeJson(fixture.settingsFile, {
      permissions: { defaultMode: "plan" },
      disableAutoMode: "enable",
      env: { ANTHROPIC_API_KEY: credential },
    });
    expectSuccess(fixture.run("connect", owner));
    const edited = {
      ...readJson(fixture.settingsFile),
      permissions: { defaultMode: "dontAsk" },
    };
    writeJson(fixture.settingsFile, edited);
    const settings = readFileSync(fixture.settingsFile);
    const state = readFileSync(fixture.stateFile);

    expectSafeFailure(fixture.run("verify-disconnect", owner));
    expect(readFileSync(fixture.settingsFile)).toEqual(settings);
    expect(readFileSync(fixture.stateFile)).toEqual(state);
    expectSuccess(fixture.run("disconnect", owner));
    expect(readJson(fixture.settingsFile)).toEqual({
      ...edited,
      disableAutoMode: "enable",
    });
    expect(existsSync(fixture.stateFile)).toBe(false);
    const restored = readFileSync(fixture.settingsFile);
    expectSuccess(fixture.run("verify-disconnect", owner));
    expect(readFileSync(fixture.settingsFile)).toEqual(restored);
  });

  test("verification rejects either remaining proxy URL after mode restoration until that connection is removed", () => {
    const owner = "https://proxy.example.test/v1/anthropic";
    for (const key of ["ANTHROPIC_BASE_URL", "ANTHROPIC_BEDROCK_BASE_URL"]) {
      const fixture = createFixture();
      const original = {
        permissions: { defaultMode: "plan" },
        disableAutoMode: "enable",
        env: { [key]: owner, ANTHROPIC_API_KEY: credential },
      };
      writeJson(fixture.settingsFile, original);
      expectSuccess(fixture.run("connect", owner));
      expectSuccess(fixture.run("disconnect", owner));
      expect(readJson(fixture.settingsFile)).toEqual(original);
      expect(existsSync(fixture.stateFile)).toBe(false);
      const restored = readFileSync(fixture.settingsFile);

      expectSafeFailure(fixture.run("verify-disconnect", owner));
      expect(readFileSync(fixture.settingsFile)).toEqual(restored);
      const disconnected = {
        ...original,
        env: {
          ...original.env,
          [key]: "https://other-proxy.example.test/v1/anthropic",
        },
      };
      writeJson(fixture.settingsFile, disconnected);
      expectSuccess(fixture.run("verify-disconnect", owner));
      expect(readJson(fixture.settingsFile)).toEqual(disconnected);
    }
  });

  test("uses a custom config directory with spaces, preserving BOM and leaving default HOME settings untouched", () => {
    const fixture = createFixture(true);
    const defaultSettings = join(fixture.home, ".claude", "settings.json");
    writeJson(defaultSettings, { permissions: { defaultMode: "plan" } });
    const defaultBytes = readFileSync(defaultSettings);
    const original = { env: { CUSTOM_VALUE: "keep" }, permissions: {} };
    mkdirSync(dirname(fixture.settingsFile), { recursive: true });
    writeFileSync(fixture.settingsFile, `\uFEFF${JSON.stringify(original)}`);

    expectSuccess(fixture.run("connect"));
    expect(readJson(fixture.settingsFile)).toEqual({
      ...original,
      permissions: { defaultMode: "acceptEdits" },
      disableAutoMode: "disable",
    });
    expect(
      readFileSync(fixture.settingsFile, "utf8").startsWith("\uFEFF"),
    ).toBe(true);
    expectSuccess(fixture.run("disconnect"));
    expect(readJson(fixture.settingsFile)).toEqual(original);
    expect(
      readFileSync(fixture.settingsFile, "utf8").startsWith("\uFEFF"),
    ).toBe(true);
    expect(readFileSync(defaultSettings)).toEqual(defaultBytes);
    expect(
      existsSync(
        join(fixture.home, ".claude", ".archestra-permission-mode.json"),
      ),
    ).toBe(false);
  });

  test("updates and restores the resolved settings target without replacing its symlink", () => {
    const fixture = createFixture();
    const target = join(fixture.root, "linked settings.json");
    const original = { permissions: { defaultMode: "plan" }, unknown: true };
    writeJson(target, original);
    mkdirSync(dirname(fixture.settingsFile), { recursive: true });
    symlinkSync(target, fixture.settingsFile);

    expectSuccess(fixture.run("connect"));
    expect(readJson(target)).toEqual({
      ...original,
      permissions: { defaultMode: "acceptEdits" },
      disableAutoMode: "disable",
    });
    expect(readJson(fixture.stateFile)).toMatchObject({
      settingsFile: realpathSync(target),
    });
    expect(lstatSync(fixture.settingsFile).isSymbolicLink()).toBe(true);
    expect(readlinkSync(fixture.settingsFile)).toBe(target);
    expectSuccess(fixture.run("disconnect"));
    expect(readJson(target)).toEqual(original);
    expect(lstatSync(fixture.settingsFile).isSymbolicLink()).toBe(true);
    expect(readlinkSync(fixture.settingsFile)).toBe(target);
  });

  test("rejects a changed symlink target without modifying either target or the backup", () => {
    const fixture = createFixture();
    const firstTarget = join(fixture.root, "first.json");
    const secondTarget = join(fixture.root, "second.json");
    writeJson(firstTarget, { permissions: { defaultMode: "plan" } });
    writeJson(secondTarget, { env: { ANTHROPIC_API_KEY: credential } });
    mkdirSync(dirname(fixture.settingsFile), { recursive: true });
    symlinkSync(firstTarget, fixture.settingsFile);
    expectSuccess(fixture.run("connect"));
    const firstBytes = readFileSync(firstTarget);
    const secondBytes = readFileSync(secondTarget);
    const backup = readFileSync(fixture.stateFile);
    unlinkSync(fixture.settingsFile);
    symlinkSync(secondTarget, fixture.settingsFile);

    for (const operation of ["connect", "disconnect"] as const) {
      expectSafeFailure(fixture.run(operation));
      expect(readFileSync(firstTarget)).toEqual(firstBytes);
      expect(readFileSync(secondTarget)).toEqual(secondBytes);
      expect(readFileSync(fixture.stateFile)).toEqual(backup);
      expect(readlinkSync(fixture.settingsFile)).toBe(secondTarget);
    }
  });

  test("rejects malformed settings without printing credentials or changing settings and backup", () => {
    for (const operation of ["connect", "disconnect"] as const) {
      const fixture = createFixture();
      writeJson(fixture.settingsFile, {});
      expectSuccess(fixture.run("connect"));
      const backup = readFileSync(fixture.stateFile);
      const malformed = `{"env":{"ANTHROPIC_API_KEY":"${credential}"}, broken}`;
      writeFileSync(fixture.settingsFile, malformed);

      expectSafeFailure(fixture.run(operation));
      expect(readFileSync(fixture.settingsFile, "utf8")).toBe(malformed);
      expect(readFileSync(fixture.stateFile)).toEqual(backup);
    }
  });

  test("rejects corrupt backup JSON or snapshot data without changing settings or discarding the backup", () => {
    const fixture = createFixture();
    writeJson(fixture.settingsFile, { env: { ANTHROPIC_API_KEY: credential } });
    expectSuccess(fixture.run("connect"));
    const settings = readFileSync(fixture.settingsFile);
    const state = readJson(fixture.stateFile);

    for (const corrupt of [
      `{"credential":"${credential}", broken}`,
      JSON.stringify({ ...state, defaultMode: { present: true } }),
      JSON.stringify({ ...state, permissionsPresent: "not-a-boolean" }),
    ]) {
      writeFileSync(fixture.stateFile, corrupt);
      for (const operation of ["connect", "disconnect"] as const) {
        expectSafeFailure(fixture.run(operation));
        expect(readFileSync(fixture.settingsFile)).toEqual(settings);
        expect(readFileSync(fixture.stateFile, "utf8")).toBe(corrupt);
      }
    }
  });
});

function createFixture(customConfigDirectory = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "claude-permissions-")));
  temporaryDirectories.push(root);
  const home = join(root, "home");
  mkdirSync(home);
  const directory = customConfigDirectory
    ? join(root, "custom config with spaces")
    : join(home, ".claude");
  return {
    root,
    home,
    settingsFile: join(directory, "settings.json"),
    stateFile: join(directory, ".archestra-permission-mode.json"),
    run(
      operation: "connect" | "disconnect" | "verify-disconnect",
      owner?: string,
    ) {
      return spawnSync(process.execPath, ["-"], {
        input: renderClaudePermissionSettingsScript(operation, owner),
        encoding: "utf8",
        cwd: root,
        env: {
          HOME: home,
          USERPROFILE: home,
          CLAUDE_CONFIG_DIR: customConfigDirectory ? directory : "",
        },
        timeout: 5_000,
      });
    },
  };
}

function writeJson(file: string, value: unknown) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
}

function readJson(file: string) {
  return JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

function expectSuccess(result: ReturnType<typeof spawnSync>) {
  expect(result.error).toBeUndefined();
  expect(result.status, String(result.stderr)).toBe(0);
  expect(result.stderr).toBe("");
  expect(String(result.stdout)).not.toContain(credential);
}

function expectSafeFailure(result: ReturnType<typeof spawnSync>) {
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(String(result.stderr)).not.toBe("");
  expect(String(result.stderr)).not.toContain(credential);
  expect(String(result.stderr)).not.toContain("ANTHROPIC_API_KEY");
}
