import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { PI_INSTALLATION } from "./pi-lifecycle";
import { PI_MCP_SIGN_IN } from "./pi-mcp-sign-in";

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0))
    fs.rmSync(home, { recursive: true, force: true });
});

test.each([
  { existing: true, answer: "", actions: ["login"], succeeds: true },
  { existing: true, answer: "k", actions: ["login"], succeeds: true },
  {
    existing: true,
    answer: "r",
    actions: ["login", "logout", "login"],
    succeeds: true,
  },
  { existing: true, answer: "c", actions: ["login"], succeeds: false },
  { existing: true, answer: "anything", actions: ["login"], succeeds: false },
  { existing: false, answer: "", actions: ["login"], succeeds: true },
  {
    existing: true,
    expired: true,
    answer: "",
    actions: ["login"],
    succeeds: true,
  },
  {
    existing: true,
    answer: "r",
    failure: "logout",
    actions: ["login", "logout"],
    succeeds: false,
  },
  {
    existing: true,
    answer: "r",
    failure: "renew",
    actions: ["login", "logout", "login"],
    succeeds: false,
  },
  {
    existing: false,
    answer: "",
    failure: "initial",
    actions: ["login"],
    succeeds: false,
  },
])("scoped official auth $existing/$expired/$answer/$failure", async (scenario) => {
  const home = fs.mkdtempSync(path.join(tmpdir(), "Pi auth 日本語 "));
  homes.push(home);
  const Installation = new Function(
    "require",
    `${PI_INSTALLATION}; return PiInstallation;`,
  )((id: string) => (id === "node:os" ? { homedir: () => home } : require(id)));
  const install = new Installation();
  const gateway = "https://example.test/mcp";
  const key = `mcp__gateway|${gateway}`;
  install.begin({ server: "gateway", gateway, providers: [] });
  const authFile = path.join(home, ".pi/agent/mcp-auth.json");
  fs.mkdirSync(path.dirname(authFile), { recursive: true });
  const unrelated = {
    clientInformation: { client_id: "other-client" },
    tokens: { access_token: "other-fixture" },
  };
  const old = {
    serverUrl: gateway,
    clientInformation: { client_id: "old-client" },
  };
  fs.writeFileSync(
    authFile,
    JSON.stringify({
      other: unrelated,
      ...(scenario.existing ? { [key]: old } : {}),
    }),
  );
  install.state.authClient = scenario.existing ? "old-client" : null;
  install.persist();
  const actions: string[] = [];
  let prompts = 0;
  let browserFlows = 0;
  const output: string[] = [];
  const signIn = new Function(
    "require",
    "process",
    "console",
    `${PI_MCP_SIGN_IN}; return signInPiGateway;`,
  )(
    (id: string) => {
      if (id === "lifecycle") return { PiInstallation: Installation };
      if (id === "node:readline/promises")
        return {
          createInterface: () => ({
            question: async (text: string) => {
              prompts++;
              expect(text).toContain("Keep existing login (default)");
              return scenario.answer;
            },
            close() {},
          }),
        };
      if (id === "node:child_process")
        return {
          spawn: (command: string, args: string[], options: object) => {
            expect(command).toBe("C:\\Program Files\\node.exe");
            expect(args.slice(0, 2)).toEqual([
              "C:\\Pi 日本語\\pi-launcher.js",
              "mcp",
            ]);
            expect(args[3]).toBe("gateway");
            expect(options).toMatchObject({
              cwd: install.root,
              shell: false,
              timeout: 130000,
            });
            const action = args[2];
            actions.push(action);
            const child = Object.assign(new EventEmitter(), {
              stdout: new EventEmitter(),
            });
            queueMicrotask(() => {
              const first = actions.length === 1;
              const fail =
                scenario.failure ===
                (action === "logout" ? "logout" : first ? "initial" : "renew");
              if (fail) {
                child.emit("close", 1);
                return;
              }
              const auth = JSON.parse(fs.readFileSync(authFile, "utf8"));
              if (action === "logout") delete auth[key];
              else if (first && scenario.existing && !scenario.expired)
                child.stdout.emit(
                  "data",
                  Buffer.from(
                    'Already signed in to MCP server "gateway" (3 tools).',
                  ),
                );
              else {
                browserFlows++;
                auth[key] = {
                  serverUrl: gateway,
                  clientInformation: { client_id: "new-client" },
                };
              }
              fs.writeFileSync(authFile, JSON.stringify(auth));
              child.emit("close", 0);
            });
            return child;
          },
        };
      return require(id);
    },
    {
      stdin: {},
      stdout: { write: (text: string) => output.push(String(text)) },
    },
    { log: (text: string) => output.push(text) },
  );
  const result = signIn({
    config: {
      piCommand: [
        "C:\\Program Files\\node.exe",
        "C:\\Pi 日本語\\pi-launcher.js",
      ],
    },
    root: install.root,
    lifecycle: "lifecycle",
  });
  if (scenario.succeeds) await expect(result).resolves.toBeUndefined();
  else await expect(result).rejects.toThrow();
  expect(actions).toEqual(scenario.actions);
  expect(prompts).toBe(scenario.existing && !scenario.expired ? 1 : 0);
  const auth = JSON.parse(fs.readFileSync(authFile, "utf8"));
  expect(auth.other).toEqual(unrelated);
  if (scenario.failure === "renew") {
    expect(auth[key]).toBeUndefined();
    expect(output.join("\n")).toContain(
      "previous gateway login was signed out",
    );
  } else if (
    scenario.succeeds &&
    (scenario.answer === "r" || !scenario.existing || scenario.expired)
  ) {
    expect(browserFlows).toBe(1);
    expect(new Installation().state.authClient).toBe("new-client");
    new Installation().disconnect();
    expect(JSON.parse(fs.readFileSync(authFile, "utf8")).other).toEqual(
      unrelated,
    );
  } else if (scenario.existing) {
    expect(browserFlows).toBe(0);
    expect(auth[key]).toEqual(old);
  }
});
