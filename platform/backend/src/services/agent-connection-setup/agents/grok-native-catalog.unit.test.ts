import { spawn } from "node:child_process";
import {
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
import { expect, test } from "vitest";
import { grokCatalogForProxy } from "../../../routes/proxy/adapters/grok-native-catalog";
import type { SetupScriptContext } from "../types";
import { grokSetup } from "./grok";

test.skipIf(!process.env.ARCHESTRA_GROK_TEST_BINARY)(
  "official Grok retains native login, model names, explicit selection and selection on resume through a new protected transport",
  async () => {
    const home = mkdtempSync(path.join(tmpdir(), "grok-native-catalog-"));
    const ordinary = path.join(home, ".grok");
    const root = path.join(home, ".archestra/grok");
    const requests: {
      model: string;
      authorization: string | undefined;
      attribution: string | undefined;
      body: object;
    }[] = [];
    let refreshed = false;
    let protectCatalog = false;
    let firstArrived!: () => void, secondArrived!: () => void;
    let releaseFirst!: () => void, releaseSecond!: () => void;
    const firstReady = new Promise<void>((resolve) => {
      firstArrived = resolve;
    });
    const secondReady = new Promise<void>((resolve) => {
      secondArrived = resolve;
    });
    const server = createServer(async (request, response) => {
      response.setHeader("Content-Type", "application/json");
      if (request.url === "/issuer/.well-known/openid-configuration") {
        const issuer = `http://${request.headers.host}/issuer`;
        response.end(
          JSON.stringify({
            issuer,
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
            jwks_uri: `${issuer}/jwks`,
            response_types_supported: ["code"],
            subject_types_supported: ["public"],
            id_token_signing_alg_values_supported: ["RS256"],
          }),
        );
      } else if (request.url === "/issuer/token") {
        let body = "";
        for await (const chunk of request) body += chunk;
        const form = new URLSearchParams(body);
        if (
          form.get("grant_type") !== "refresh_token" ||
          form.get("refresh_token") !== "synthetic-refresh"
        ) {
          response.writeHead(400).end();
          return;
        }
        refreshed = true;
        response.end(
          JSON.stringify({
            access_token: "synthetic-refreshed-session",
            refresh_token: "synthetic-rotated-refresh",
            token_type: "Bearer",
            expires_in: 3600,
          }),
        );
      } else if (request.url === "/v1/xai/native/settings") {
        response.end(
          '{"default_model":"native-one","session_summary_model":"native-two","web_search_model":"native-two","accept_request_encodings":["zstd"]}',
        );
      } else if (request.url === "/v1/xai/native/models") {
        response.end(
          JSON.stringify(
            (protectCatalog
              ? grokCatalogForProxy
              : (value: Record<string, unknown>) => value)({
              data: [
                {
                  id: "native-one",
                  name: "Native One",
                  model: "wire-one",
                  api_backend: "responses",
                  context_window: 200000,
                  supportsBackendSearch: true,
                  supports_backend_search: true,
                  _meta: { supportsBackendSearch: true },
                  reasoningEfforts: [
                    { value: "high", label: "High", default: true },
                  ],
                },
                {
                  id: "native-two",
                  name: "Native Two",
                  model: "wire-two",
                  api_backend: "responses",
                  context_window: 200000,
                  supportsBackendSearch: true,
                  supports_backend_search: true,
                },
              ],
            }),
          ),
        );
      } else if (request.url === "/v1/xai/responses") {
        let body = "";
        for await (const chunk of request) body += chunk;
        const parsed = JSON.parse(body);
        requests.push({
          model: parsed.model,
          authorization: request.headers.authorization,
          attribution: request.headers["x-archestra-virtual-key"] as
            | string
            | undefined,
          body: parsed,
        });
        if (parsed.model === "wire-two") {
          const input = JSON.stringify(parsed.input);
          if (input.includes("SYNTHETIC_CONCURRENT_ONE")) {
            firstArrived();
            await new Promise<void>((resolve) => {
              releaseFirst = resolve;
            });
          } else if (input.includes("SYNTHETIC_CONCURRENT_TWO")) {
            secondArrived();
            await new Promise<void>((resolve) => {
              releaseSecond = resolve;
            });
          }
        }
        response.setHeader("Content-Type", "text/event-stream");
        response.end(
          "event: response.completed\ndata: " +
            JSON.stringify({
              type: "response.completed",
              sequence_number: 1,
              response: {
                id: "resp_synthetic",
                object: "response",
                created_at: 1,
                model: parsed.model,
                status: "completed",
                output: [
                  {
                    id: "msg_synthetic",
                    type: "message",
                    role: "assistant",
                    status: "completed",
                    content: [
                      {
                        type: "output_text",
                        text: "Synthetic protected result.",
                        annotations: [],
                      },
                    ],
                  },
                ],
                usage: {
                  input_tokens: 1,
                  output_tokens: 1,
                  total_tokens: 2,
                  input_tokens_details: { cached_tokens: 0 },
                  output_tokens_details: { reasoning_tokens: 0 },
                },
              },
            }) +
            "\n\n",
        );
      } else {
        response.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/xai`;
    mkdirSync(ordinary);
    mkdirSync(path.join(home, "bin"));
    symlinkSync(
      process.env.ARCHESTRA_GROK_TEST_BINARY as string,
      path.join(home, "bin/grok"),
    );
    const auth = JSON.stringify({
      "https://accounts.x.ai/sign-in": {
        key: "synthetic-native-session",
        auth_mode: "oidc",
        user_id: "synthetic-user",
        email: "synthetic@example.test",
        create_time: new Date().toISOString(),
        expires_at: "2099-01-01T00:00:00Z",
      },
    });
    const authPath = path.join(home, "ordinary-login.json");
    writeFileSync(authPath, auth, { mode: 0o600 });
    const original =
      '[models]\ndefault="native-two"\nallowed_models=["native-one","native-two"]\n';
    writeFileSync(path.join(ordinary, "config.toml"), original);
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !/^(?:GROK_|XAI_)/.test(key),
      ),
    );
    Object.assign(env, {
      HOME: home,
      GROK_HOME: ordinary,
      GROK_AUTH_PATH: authPath,
      PATH: path.join(home, "bin") + path.delimiter + process.env.PATH,
      GROK_DISABLE_AUTOUPDATER: "1",
      GROK_TELEMETRY_ENABLED: "0",
      XAI_API_KEY: "synthetic-unwanted-key",
      GROK_MODELS_BASE_URL: "https://unprotected.invalid/v1",
    });
    const ctx: SetupScriptContext = {
      clientId: "grok-build",
      platform: "linux",
      appName: "Archestra",
      skills: null,
      mcp: null,
      proxy: {
        authMode: "native-session",
        provider: "xai",
        providerLabel: "xAI",
        baseUrl: url,
        url,
        proxyName: "Synthetic",
        virtualKey: null,
        virtualKeyName: null,
        passthroughVirtualKey: "synthetic-attribution",
        model: null,
      },
    };
    const run = (command: string, args: string[], input?: string) =>
      new Promise<{ status: number | null; stdout: string; stderr: string }>(
        (resolve, reject) => {
          const child = spawn(command, args, {
            cwd: home,
            env,
            stdio: ["pipe", "pipe", "pipe"],
          });
          let stdout = "",
            stderr = "";
          child.stdout.on("data", (chunk) => {
            stdout += chunk;
          });
          child.stderr.on("data", (chunk) => {
            stderr += chunk;
          });
          child.stdin.end(input);
          const timeout = setTimeout(() => child.kill("SIGTERM"), 30000);
          child.once("error", reject);
          child.once("close", (status) => {
            clearTimeout(timeout);
            resolve({ status, stdout, stderr });
          });
        },
      );
    const launch = (...args: string[]) =>
      run(process.execPath, [path.join(root, "launch.cjs"), ...args]);
    try {
      const setup = await run(
        "bash",
        ["-s"],
        grokSetup.bash.sections(ctx).join("\n"),
      );
      expect(setup.status, setup.stderr).toBe(0);
      const control = await launch(
        "-m",
        "native-one",
        "-p",
        "Synthetic vendor catalog control",
        "--output-format",
        "json",
        "--max-turns",
        "1",
      );
      expect(control.status, control.stderr).toBe(0);
      const hasHostedSearch = (request: (typeof requests)[number]) =>
        (request.body as { tools?: { type?: string }[] }).tools?.some(
          (tool) => tool.type === "x_search" || tool.type === "web_search",
        ) === true;
      expect(requests.some(hasHostedSearch)).toBe(true);
      requests.length = 0;
      protectCatalog = true;
      const correctedResume = await launch(
        "--resume",
        JSON.parse(control.stdout).sessionId,
        "-p",
        "Synthetic corrected catalog after resume",
        "--output-format",
        "json",
        "--max-turns",
        "1",
      );
      expect(correctedResume.status, correctedResume.stderr).toBe(0);
      expect(requests.some(hasHostedSearch)).toBe(false);
      const models = await launch("models");
      expect(models.status, models.stderr).toBe(0);
      expect(models.stdout).toContain("native-one");
      expect(models.stdout).toContain("native-two");
      expect(models.stdout).not.toContain("Archestra");
      const firstStart = requests.length;
      const first = await launch(
        "-p",
        "Synthetic native default",
        "--output-format",
        "json",
        "--max-turns",
        "1",
      );
      expect(first.status, first.stderr).toBe(0);
      expect(first.stdout).toContain("Synthetic protected result.");
      expect(requests.at(-1)?.model).toBe("wire-two");
      const exposesSpawn = (request: (typeof requests)[number]) =>
        (
          request.body as {
            tools?: { name?: string; function?: { name?: string } }[];
          }
        ).tools?.some(
          (tool) => (tool.name ?? tool.function?.name) === "spawn_subagent",
        ) === true;
      expect(requests.slice(firstStart).some(exposesSpawn)).toBe(true);
      const disabledStart = requests.length;
      const disabled = await launch(
        "--no-subagents",
        "-p",
        "Synthetic explicit subagent opt-out",
        "--output-format",
        "json",
        "--max-turns",
        "1",
      );
      expect(disabled.status, disabled.stderr).toBe(0);
      expect(requests.slice(disabledStart)).not.toHaveLength(0);
      expect(requests.slice(disabledStart).some(exposesSpawn)).toBe(false);
      const chosen = await launch(
        "-m",
        "native-one",
        "--reasoning-effort",
        "high",
        "-p",
        "Synthetic selection",
        "--output-format",
        "json",
        "--max-turns",
        "1",
      );
      expect(chosen.status, chosen.stderr).toBe(0);
      expect(requests.at(-1)?.model).toBe("wire-one");
      expect(requests.at(-1)?.body).toMatchObject({
        reasoning: { effort: "high" },
      });
      const session = JSON.parse(chosen.stdout).sessionId;
      const resumed = await launch(
        "--resume",
        session,
        "-p",
        "Synthetic resumed turn",
        "--output-format",
        "json",
        "--max-turns",
        "1",
      );
      expect(resumed.status, resumed.stderr).toBe(0);
      expect(resumed.stdout).toContain("Synthetic protected result.");
      expect(requests.at(-1)?.model).toBe("wire-one");
      const concurrentArgs = [
        "-m",
        "native-two",
        "--output-format",
        "json",
        "--max-turns",
        "1",
      ];
      const one = launch(...concurrentArgs, "-p", "SYNTHETIC_CONCURRENT_ONE");
      await Promise.race([
        firstReady,
        one.then((result) => {
          throw new Error(
            `First concurrent launch ended before inference: ${result.stderr}`,
          );
        }),
      ]);
      const two = launch(...concurrentArgs, "-p", "SYNTHETIC_CONCURRENT_TWO");
      await Promise.race([
        secondReady,
        two.then((result) => {
          throw new Error(
            `Second concurrent launch ended before inference: ${result.stderr}`,
          );
        }),
      ]);
      releaseFirst();
      const firstResult = await one;
      expect(firstResult.status, firstResult.stderr).toBe(0);
      releaseSecond();
      const secondResult = await two;
      expect(secondResult.status, secondResult.stderr).toBe(0);
      expect(secondResult.stdout).toContain("Synthetic protected result.");
      expect(
        requests.every(
          (request) =>
            request.authorization === "Bearer synthetic-native-session" &&
            request.attribution === "synthetic-attribution",
        ),
      ).toBe(true);
      expect(readFileSync(authPath, "utf8")).toBe(auth);
      expect(existsSync(path.join(root, "native/auth.json"))).toBe(false);
      expect(readFileSync(path.join(ordinary, "config.toml"), "utf8")).toBe(
        original,
      );
      expect(
        readFileSync(path.join(root, "native/config.toml"), "utf8"),
      ).not.toContain("[model.archestra]");
      const issuer = url.replace("/v1/xai", "/issuer");
      Object.assign(env, {
        GROK_OAUTH2_ISSUER: issuer,
        GROK_OAUTH2_CLIENT_ID: "synthetic-client",
      });
      writeFileSync(
        authPath,
        JSON.stringify({
          [`${issuer}::synthetic-client`]: {
            key: "synthetic-expired-session",
            auth_mode: "oidc",
            user_id: "synthetic-user",
            create_time: "2020-01-01T00:00:00Z",
            expires_at: "2020-01-01T00:00:00Z",
            refresh_token: "synthetic-refresh",
            oidc_issuer: issuer,
            oidc_client_id: "synthetic-client",
          },
        }),
      );
      const renewedTurn = await launch(
        "-m",
        "native-two",
        "-p",
        "Synthetic refresh",
        "--output-format",
        "json",
        "--max-turns",
        "1",
      );
      expect(renewedTurn.status, renewedTurn.stderr).toBe(0);
      expect(refreshed).toBe(true);
      expect(requests.at(-1)?.authorization).toBe(
        "Bearer synthetic-refreshed-session",
      );
      expect(requests.some(hasHostedSearch)).toBe(false);
      const renewedAuth = readFileSync(authPath, "utf8");
      expect(
        JSON.parse(renewedAuth)[`${issuer}::synthetic-client`].refresh_token,
      ).toBe("synthetic-rotated-refresh");
      expect(existsSync(path.join(root, "native/auth.json"))).toBe(false);
      const disconnected = await run(process.execPath, [
        path.join(root, "disconnect.cjs"),
      ]);
      expect(disconnected.status, disconnected.stderr).toBe(0);
      expect(readFileSync(authPath, "utf8")).toBe(renewedAuth);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(home, { recursive: true, force: true });
    }
  },
  120000,
);
