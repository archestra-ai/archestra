import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { PI_INSTALLATION, PI_WINDOWS_PATH } from "./pi-lifecycle";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    fs.rmSync(home, { recursive: true, force: true });
});

test.each([
  true,
  false,
])("Windows PATH ownership is durable before mutation; preexisting=%s", (preexisting) => {
  const home = fs.mkdtempSync(path.join(tmpdir(), "Pi home 日本語 "));
  homes.push(home);
  const bin = path.join(home, ".local/bin");
  const commands: Array<{ args: string[]; options: object }> = [];
  const requireBoundary = (id: string) => {
    if (id === "node:os") return { homedir: () => home };
    if (id === "node:child_process")
      return {
        execFileSync: (command: string, args: string[], options: object) => {
          expect(command).toBe("powershell.exe");
          commands.push({ args, options });
          if (args.includes("read"))
            return JSON.stringify(
              preexisting ? bin : "C:\\User tools;C:\\日本語",
            );
          const snapshot = JSON.parse(
            fs.readFileSync(
              path.join(home, ".archestra/pi/install-state.json"),
              "utf8",
            ),
          );
          expect(snapshot.windowsPath).toMatchObject({
            added: !preexisting,
            bin,
          });
          expect(args).toContain(
            preexisting ? "never" : commands.length === 2 ? "add" : "remove",
          );
          return "";
        },
      };
    return require(id);
  };
  const Installation = new Function(
    "require",
    `${PI_INSTALLATION}; return PiInstallation;`,
  )(requireBoundary);
  const install = new Installation();
  install.begin({
    server: "gateway",
    gateway: "https://example.test/mcp",
    providers: ["archestra-openai"],
  });
  const script = path.join(home, ".archestra/pi/path.ps1");
  install.write(script, PI_WINDOWS_PATH);
  install.windowsPath(script);
  install.windowsPath(script);
  install.disconnect();
  expect(commands.map(({ args }) => args[3])).toEqual(
    preexisting ? ["read"] : ["read", "add", "remove"],
  );
  for (const command of commands) {
    expect(command.args.slice(0, 3)).toEqual(["-NoProfile", "-File", script]);
    expect(command.args.at(-1)).toBe(bin);
    expect(command.options).toMatchObject({ timeout: 10000 });
    expect(command.options).not.toHaveProperty("shell", true);
  }
  expect(fs.existsSync(script)).toBe(false);
  // Idempotent local recovery with no configuration left to remove.
  expect(() => install.disconnect()).not.toThrow();
});

test("re-reads the snapshot after acquiring the lock so concurrent setup changes are not lost", () => {
  const home = fs.mkdtempSync(path.join(tmpdir(), "Pi lock "));
  homes.push(home);
  const Installation = new Function(
    "require",
    `${PI_INSTALLATION}; return PiInstallation;`,
  )((id: string) => (id === "node:os" ? { homedir: () => home } : require(id)));
  const first = new Installation();
  first.lock();
  first.begin({
    server: "gateway",
    gateway: "https://example.test/mcp",
    providers: [],
  });
  first.unlock();
  const stale = new Installation();
  first.lock();
  const managed = path.join(home, ".archestra/pi/managed.cjs");
  first.write(managed, "managed bytes");
  first.unlock();
  stale.lock();
  expect(stale.state.files[".archestra/pi/managed.cjs"].before).toBeNull();
  stale.disconnect();
  stale.unlock();
  expect(fs.existsSync(managed)).toBe(false);
});

test("restores an older snapshot that has original bytes but no optional file-mode metadata", () => {
  const home = fs.mkdtempSync(path.join(tmpdir(), "Pi old snapshot "));
  homes.push(home);
  const Installation = new Function(
    "require",
    `${PI_INSTALLATION}; return PiInstallation;`,
  )((id: string) => (id === "node:os" ? { homedir: () => home } : require(id)));
  const install = new Installation();
  install.begin({
    server: "gateway",
    gateway: "https://example.test/mcp",
    providers: [],
  });
  const file = path.join(home, ".archestra/pi/prior.cjs");
  fs.writeFileSync(file, "original");
  install.write(file, "installed");
  delete install.state.files[".archestra/pi/prior.cjs"].beforeMode;
  install.persist();
  install.disconnect();
  expect(fs.readFileSync(file, "utf8")).toBe("original");
});

test("retries interrupted restoration after restoring a distinct prior OAuth client, but rejects edits to that record", () => {
  const home = fs.mkdtempSync(path.join(tmpdir(), "Pi interrupted restore "));
  homes.push(home);
  const authFile = path.join(home, ".pi/agent/mcp-auth.json");
  const managed = path.join(home, ".archestra/pi/managed.cjs");
  const gateway = "https://example.test/mcp";
  const key = `mcp__gateway|${gateway}`;
  const prior = {
    serverUrl: gateway,
    clientInformation: { client_id: "prior-client" },
    tokens: { access_token: "prior-test-token" },
  };
  fs.mkdirSync(path.dirname(authFile), { recursive: true });
  fs.writeFileSync(authFile, JSON.stringify({ [key]: prior }));
  let interrupt = false;
  const Installation = new Function(
    "require",
    `${PI_INSTALLATION}; return PiInstallation;`,
  )((id: string) => {
    if (id === "node:os") return { homedir: () => home };
    if (id === "node:fs")
      return {
        ...fs,
        renameSync: (from: string, to: string) => {
          if (interrupt && to === managed) throw new Error("Test disk error");
          fs.renameSync(from, to);
        },
      };
    return require(id);
  });
  const install = new Installation();
  install.begin({ server: "gateway", gateway, providers: [] });
  fs.writeFileSync(managed, "original");
  install.write(managed, "connected");
  install.state.authClient = "connected-client";
  install.persist();
  fs.writeFileSync(
    authFile,
    JSON.stringify({
      [key]: {
        ...prior,
        clientInformation: { client_id: "connected-client" },
        tokens: { access_token: "connected-test-token" },
      },
    }),
  );
  interrupt = true;
  expect(() => install.disconnect()).toThrow("Test disk error");
  expect(JSON.parse(fs.readFileSync(authFile, "utf8"))[key]).toEqual(prior);
  expect(fs.readFileSync(managed, "utf8")).toBe("connected");
  expect(fs.existsSync(install.stateFile)).toBe(true);

  interrupt = false;
  // Matching only the old client ID must not allow a later user edit.
  fs.writeFileSync(
    authFile,
    JSON.stringify({
      [key]: { ...prior, tokens: { access_token: "user-edit" } },
    }),
  );
  expect(() => new Installation().disconnect()).toThrow(
    "sign-in record changed",
  );
  expect(fs.readFileSync(managed, "utf8")).toBe("connected");
  fs.writeFileSync(authFile, JSON.stringify({ [key]: prior }));
  const retry = new Installation();
  retry.disconnect();
  expect(fs.readFileSync(managed, "utf8")).toBe("original");
  expect(JSON.parse(fs.readFileSync(authFile, "utf8"))[key]).toEqual(prior);
  expect(fs.existsSync(retry.stateFile)).toBe(false);
  expect(() => retry.disconnect()).not.toThrow();
});

test.each([
  "archestra-openai",
  "archestra-anthropic",
  "unrelated",
])("disconnect after catalog-changing reconnect preserves ownership for %s", (selected) => {
  const home = fs.mkdtempSync(path.join(tmpdir(), "Pi reconnect "));
  homes.push(home);
  const settingsFile = path.join(home, ".pi/agent/settings.json");
  fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  const original = {
    defaultProvider: "original",
    defaultModel: "original-model",
    theme: "light",
  };
  fs.writeFileSync(settingsFile, JSON.stringify(original));
  const Installation = new Function(
    "require",
    `${PI_INSTALLATION}; return PiInstallation;`,
  )((id: string) => (id === "node:os" ? { homedir: () => home } : require(id)));
  const install = new Installation();
  const connection = { server: "gateway", gateway: "https://example.test/mcp" };
  install.begin({ ...connection, providers: ["archestra-openai"] });
  const extension = path.join(home, ".pi/agent/extensions/archestra-pi.js");
  install.write(extension, "first");
  install.begin({ ...connection, providers: ["archestra-anthropic"] });
  install.write(extension, "second");
  fs.writeFileSync(
    settingsFile,
    JSON.stringify({
      ...original,
      defaultProvider: selected,
      defaultModel: "selected-model",
      theme: "dark",
    }),
  );
  const reloaded = new Installation();
  expect(reloaded.state.providers).toEqual([
    "archestra-openai",
    "archestra-anthropic",
  ]);
  reloaded.disconnect();
  expect(JSON.parse(fs.readFileSync(settingsFile, "utf8"))).toEqual({
    ...original,
    theme: "dark",
    ...(selected === "unrelated"
      ? { defaultProvider: selected, defaultModel: "selected-model" }
      : {}),
  });
  expect(fs.existsSync(extension)).toBe(false);
  expect(fs.existsSync(reloaded.stateFile)).toBe(false);
});
