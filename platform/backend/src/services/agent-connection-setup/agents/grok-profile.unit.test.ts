import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { parse, stringify } from "smol-toml";
import { expect, test } from "vitest";
import { HISTORICAL_GROK_SETUPS } from "../../../test/fixtures/grok-historical-setups";
import type { SetupScriptContext } from "../types";
import { grokSetup } from "./grok";

test.skipIf(!process.env.ARCHESTRA_GROK_TEST_BINARY)(
  "historical managed alias plus native default is repaired; bare and protected native processes coexist, and registered foreign hooks cannot run",
  async () => {
    const binary = process.env.ARCHESTRA_GROK_TEST_BINARY as string;
    const home = mkdtempSync(path.join(tmpdir(), "grok-full-profile-"));
    const nativeHome = path.join(home, ".grok"),
      config = path.join(nativeHome, "config.toml"),
      root = path.join(home, ".archestra/grok");
    const requests: { model: string; ambient: boolean }[] = [];
    let releaseProtected: (() => void) | undefined;
    let startedProtected: (() => void) | undefined;
    let hold = false;
    const server = createServer(async (request, response) => {
      if (request.method !== "POST") {
        response.setHeader("Content-Type", "application/json");
        response.end(
          JSON.stringify({
            data: [
              {
                id: "grok-4.7",
                model: "native-synthetic",
                name: "Synthetic native default",
                api_backend: "chat_completions",
                base_url: `http://${request.headers.host}/v1`,
              },
            ],
          }),
        );
        return;
      }
      let text = "";
      for await (const chunk of request) text += chunk;
      const body = JSON.parse(text);
      if (body.jsonrpc === "2.0") {
        response.setHeader("Content-Type", "application/json");
        if (body.id === undefined) {
          response.writeHead(202);
          response.end();
          return;
        }
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result:
              body.method === "initialize"
                ? {
                    protocolVersion: "2025-03-26",
                    capabilities: { tools: {} },
                    serverInfo: { name: "synthetic", version: "1" },
                  }
                : { tools: [] },
          }),
        );
        return;
      }
      requests.push({
        model: body.model,
        ambient: JSON.stringify(body).includes("AMBIENT_OTHER_CLIENT_CONTEXT"),
      });
      if (body.model === "protected-synthetic" && hold) {
        startedProtected?.();
        await new Promise<void>((resolve) => (releaseProtected = resolve));
      }
      response.setHeader("Content-Type", "text/event-stream");
      response.end(
        "data: " +
          JSON.stringify({
            id: "synthetic",
            object: "chat.completion.chunk",
            created: 1,
            model: body.model,
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  content: "Synthetic profile result.",
                },
                finish_reason: "stop",
              },
            ],
          }) +
          "\n\ndata: [DONE]\n\n",
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing fixture listener");
    const base = `http://127.0.0.1:${address.port}/v1`;
    mkdirSync(nativeHome);
    mkdirSync(path.join(home, "bin"));
    symlinkSync(binary, path.join(home, "bin/grok"));
    const env = {
      ...process.env,
      HOME: home,
      GROK_HOME: nativeHome,
      PATH: path.join(home, "bin") + path.delimiter + process.env.PATH,
      GROK_DEFAULT_MODEL: "grok-4.7",
      GROK_DISABLE_AUTOUPDATER: "1",
      GROK_TELEMETRY_ENABLED: "0",
      GROK_CLI_CHAT_PROXY_BASE_URL: base,
      GROK_MODELS_BASE_URL: base,
      GROK_MODELS_LIST_URL: `${base}/models`,
      GROK_XAI_API_BASE_URL: base,
      XAI_API_KEY: "synthetic-profile-key",
    };
    const run = (command: string, args: string[], input?: string) =>
      new Promise<{ status: number | null; stdout: string; stderr: string }>(
        (resolve) => {
          const child = spawn(command, args, {
            env,
            cwd: home,
            stdio: ["pipe", "pipe", "pipe"],
          });
          let stdout = "",
            stderr = "";
          child.stdout.on("data", (chunk) => (stdout += chunk));
          child.stderr.on("data", (chunk) => (stderr += chunk));
          child.stdin.end(input);
          const timer = setTimeout(() => child.kill("SIGTERM"), 20000);
          child.once("close", (status) => {
            clearTimeout(timer);
            resolve({ status, stdout, stderr });
          });
        },
      );
    const prompt = [
      "-p",
      "Synthetic fixture",
      "--output-format",
      "json",
      "--max-turns",
      "1",
      "--no-subagents",
    ];
    try {
      const original =
        '[models]\ndefault="grok-4.7"\nweb_search="grok-4.7"\nallowed_models=["grok-4.7"]\n[ui]\ncolor="blue"\n';
      writeFileSync(config, original);
      const old = gunzipSync(
        Buffer.from(HISTORICAL_GROK_SETUPS["71b2"].gzip, "base64"),
      )
        .toString()
        .replaceAll("https://proxy.example", base);
      expect((await run("bash", ["-s"], old)).status).toBe(0);
      expect(
        parse(readFileSync(config, "utf8")).model as object,
      ).toHaveProperty("archestra");
      const remembered = parse(readFileSync(config, "utf8"));
      (remembered.models as Record<string, unknown>).default = "grok-4.7";
      writeFileSync(config, stringify(remembered));
      expect(
        (
          await run(binary, [
            "mcp",
            "add",
            "user-extra",
            `${base}/mcp`,
            "--scope",
            "user",
          ])
        ).status,
      ).toBe(0);
      expect(
        (parse(readFileSync(config, "utf8")).models as Record<string, unknown>)
          .allowed_models,
      ).toEqual(["archestra"]);
      const pty = String.raw`import errno,fcntl,os,pty,select,struct,subprocess,sys,termios,time
master,slave=pty.openpty()
fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',30,100,0,0))
child=subprocess.Popen(sys.argv[1:],stdin=slave,stdout=slave,stderr=slave,env=os.environ)
os.close(slave)
output=b'';deadline=time.monotonic()+4
while time.monotonic()<deadline:
 ready,_,_=select.select([master],[],[],0.05)
 if ready:
  try:
   data=os.read(master,65536)
   if not data:break
   output+=data
   if b'\x1b[6n' in data:os.write(master,b'\x1b[1;1R')
  except OSError as error:
   if error.errno==errno.EIO:break
   raise
 if child.poll() is not None:break
if child.poll() is None:child.terminate()
child.wait(timeout=3)
os.close(master)
sys.stdout.write(output.decode(errors='replace'))
`;
      const broken = await run("python3", [
        "-c",
        pty,
        binary,
        "--no-alt-screen",
      ]);
      expect(broken.stdout + broken.stderr).toContain("allowed_models");
      expect(requests).toHaveLength(0);
      const context: SetupScriptContext = {
        clientId: "grok-build",
        platform: "windows",
        appName: "Synthetic Platform",
        skills: null,
        mcp: null,
        proxy: {
          authMode: "virtual-key",
          provider: "xai",
          providerLabel: "xAI",
          baseUrl: base,
          url: base,
          proxyName: "proxy",
          virtualKey: "synthetic-protected-key",
          virtualKeyName: "test",
          passthroughVirtualKey: null,
          model: "protected-synthetic",
        },
      };
      const encoded = /\$archNodeScript = '([^']+)'/.exec(
        grokSetup.powerShell.sections(context).join("\n"),
      )?.[1];
      if (!encoded) throw new Error("Missing generated Windows Node payload");
      const installer = path.join(home, "setup.cjs");
      writeFileSync(installer, Buffer.from(encoded, "base64"));
      for (const attempt of [1, 2])
        expect(
          (await run(process.execPath, [installer])).status,
          String(attempt),
        ).toBe(0);
      expect(parse(readFileSync(config, "utf8")).models).toEqual(
        parse(original).models,
      );
      const before = readFileSync(config, "utf8");
      hold = true;
      const started = new Promise<void>(
        (resolve) => (startedProtected = resolve),
      );
      const protectedTurn = run(process.execPath, [
        path.join(root, "launch.cjs"),
        ...prompt.filter((arg) => arg !== "--no-subagents"),
      ]);
      await Promise.race([
        started,
        protectedTurn.then((result) => {
          throw new Error(
            `Synthetic protected process exited before inference: ${result.stderr}`,
          );
        }),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("Protected turn did not start")),
            12000,
          ),
        ),
      ]);
      const bare = await run(binary, prompt);
      expect(bare.status, bare.stderr).toBe(0);
      expect(readFileSync(config, "utf8")).toBe(before);
      hold = false;
      releaseProtected?.();
      const protectedResult = await protectedTurn;
      expect(protectedResult.status, protectedResult.stderr).toBe(0);
      expect(
        requests.some((request) => request.model === "native-synthetic"),
      ).toBe(true);
      expect(
        requests.some((request) => request.model === "protected-synthetic"),
      ).toBe(true);
      const plugin = path.join(
          home,
          ".claude/plugins/cache/synthetic/ambient/1.0.0",
        ),
        counter = path.join(home, "hook-counter");
      mkdirSync(path.join(plugin, ".claude-plugin"), { recursive: true });
      mkdirSync(path.join(plugin, "hooks"));
      writeFileSync(
        path.join(plugin, ".claude-plugin/plugin.json"),
        JSON.stringify({
          name: "synthetic-ambient-plugin",
          version: "1.0.0",
          description: "Registered ambient fixture",
        }),
      );
      const hook = path.join(home, "hook.cjs");
      writeFileSync(
        hook,
        'require("node:fs").appendFileSync(' +
          JSON.stringify(counter) +
          ',"ran\\n");console.log(JSON.stringify({hookSpecificOutput:{hookEventName:"UserPromptSubmit",additionalContext:"AMBIENT_OTHER_CLIENT_CONTEXT"}}));',
      );
      writeFileSync(
        path.join(plugin, "hooks/hooks.json"),
        JSON.stringify({
          hooks: {
            ...Object.fromEntries(
              ["SessionStart", "PreToolUse", "PostToolUse"].map((event) => [
                event,
                [
                  {
                    hooks: [
                      {
                        type: "command",
                        command: `node ${JSON.stringify(hook)}`,
                      },
                    ],
                  },
                ],
              ]),
            ),
            UserPromptSubmit: [
              {
                hooks: [
                  { type: "command", command: `node ${JSON.stringify(hook)}` },
                ],
              },
            ],
          },
        }),
      );
      expect(
        (await run(binary, ["plugin", "install", plugin, "--trust"])).status,
      ).toBe(0);
      expect(
        (await run(binary, ["plugin", "enable", "synthetic-ambient-plugin"]))
          .status,
      ).toBe(0);
      expect((await run(binary, prompt)).status).toBe(0);
      expect(existsSync(counter)).toBe(true);
      // A home-directory launch also discovers legacy Claude plugin folders
      // outside GROK_HOME. Compatibility flags alone do not suppress them.
      cpSync(plugin, path.join(home, ".claude/plugins/direct"), {
        recursive: true,
      });
      const counterBefore = readFileSync(counter, "utf8"),
        requestsBefore = requests.length,
        configBefore = readFileSync(config, "utf8");
      const registryFile = path.join(
          nativeHome,
          "installed-plugins/registry.json",
        ),
        registryBefore = readFileSync(registryFile, "utf8");
      const isolated = await run(process.execPath, [
        path.join(root, "launch.cjs"),
        ...prompt.filter((arg) => arg !== "--no-subagents"),
      ]);
      expect(isolated.status, isolated.stderr).toBe(0);
      expect(readFileSync(counter, "utf8")).toBe(counterBefore);
      expect(requests.length).toBeGreaterThan(requestsBefore);
      expect(
        requests.slice(requestsBefore).some((request) => request.ambient),
      ).toBe(false);
      expect(parse(readFileSync(config, "utf8"))).toEqual(parse(configBefore));
      expect(readFileSync(registryFile, "utf8")).toBe(registryBefore);
      const namedBase = base.replace("127.0.0.1", "stack2.localhost");
      const namedSetup = await run(
        "bash",
        ["-s"],
        grokSetup.bash
          .sections({
            ...context,
            proxy: context.proxy
              ? { ...context.proxy, url: namedBase, baseUrl: namedBase }
              : null,
          })
          .join("\n"),
      );
      expect(namedSetup.status, namedSetup.stderr).toBe(0);
      const namedTurn = await run(process.execPath, [
        path.join(root, "launch.cjs"),
        ...prompt.filter((arg) => arg !== "--no-subagents"),
      ]);
      expect(namedTurn.status, namedTurn.stderr).toBe(0);
      expect(namedTurn.stdout).toContain("Synthetic profile result.");
      expect(readFileSync(counter, "utf8")).toBe(counterBefore);
      expect(
        (await run(process.execPath, [path.join(root, "launch.cjs"), "--sync"]))
          .status,
      ).toBe(0);
      expect(
        (await run(process.execPath, [path.join(root, "disconnect.cjs")]))
          .status,
      ).toBe(0);
      expect(parse(readFileSync(config, "utf8")).models).toEqual(
        parse(original).models,
      );
    } finally {
      releaseProtected?.();
      server.close();
      rmSync(home, { recursive: true, force: true });
    }
  },
  60000,
);
