import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const native = vi.hoisted(() => ({
  checkSession: vi.fn(),
  runSandbox: vi.fn(),
  readArtifact: vi.fn(),
  flushTelemetry: vi.fn(),
}));

// The native addon is the process boundary to the Dagger engine.
vi.mock("@archestra/sandbox-rs", () => native);

const IMAGE_PULL_MESSAGE =
  'could not pull the sandbox base image "ghcr.io/example/base:1" from ghcr.io. Check that the network egress policy allows ghcr.io and that the image exists.';

describe("sandboxRuntimeService", () => {
  beforeEach(() => {
    vi.resetModules();
    for (const fn of Object.values(native)) fn.mockReset();
  });

  afterEach(() => {
    delete process.env._EXPERIMENTAL_DAGGER_RUNNER_HOST;
  });

  test("surfaces a blocked base-image pull without reporting an engine outage", async () => {
    const { sandboxRuntimeService, SandboxRuntimeError } = await load({
      runnerHost: undefined,
    });
    native.runSandbox.mockRejectedValue(imagePullError());

    const error = await sandboxRuntimeService
      .runCommand(runParams())
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(SandboxRuntimeError);
    expect(error).toMatchObject({
      code: "ARCHESTRA_SANDBOX_IMAGE_PULL_FAILED",
      message: IMAGE_PULL_MESSAGE,
    });
    // the engine answered, so the runtime stays usable for the next call.
    expect(sandboxRuntimeService.isReady).toBe(true);
  });

  test("keeps naming the blocked image while the shared engine is cooling down", async () => {
    const { sandboxRuntimeService } = await load({
      runnerHost: "tcp://dagger-engine:1234",
    });
    native.checkSession.mockRejectedValue(imagePullError());

    for (let call = 0; call < 2; call++) {
      await expect(
        sandboxRuntimeService.runCommand(runParams()),
      ).rejects.toMatchObject({
        code: "ARCHESTRA_SANDBOX_IMAGE_PULL_FAILED",
        message: IMAGE_PULL_MESSAGE,
      });
    }
    expect(native.runSandbox).not.toHaveBeenCalled();
  });

  test("reports setup failures without putting a healthy runtime into cooldown", async () => {
    const { sandboxRuntimeService } = await load({ runnerHost: undefined });
    const message =
      "sandbox base image setup failed during Python package setup (uv) (exit code 1).";
    native.runSandbox
      .mockRejectedValueOnce(
        Object.assign(new Error(message), { code: "ARCHESTRA_COMMAND_FAILED" }),
      )
      .mockResolvedValueOnce({ exitCode: 0, stdout: "ok", stderr: "" });

    await expect(
      sandboxRuntimeService.runCommand(runParams()),
    ).rejects.toMatchObject({
      code: "ARCHESTRA_COMMAND_FAILED",
      message,
    });
    expect(sandboxRuntimeService.isReady).toBe(true);
    await expect(
      sandboxRuntimeService.runCommand(runParams()),
    ).resolves.toMatchObject({ exitCode: 0 });
  });

  test("keeps shared-runner setup diagnostics through the initialization cooldown", async () => {
    const { sandboxRuntimeService } = await load({
      runnerHost: "tcp://dagger-engine:1234",
    });
    const message =
      "sandbox base image setup failed during system package setup (apt) (exit code 100).";
    native.checkSession.mockRejectedValue(
      Object.assign(new Error(message), { code: "ARCHESTRA_COMMAND_FAILED" }),
    );
    for (let call = 0; call < 2; call++) {
      await expect(
        sandboxRuntimeService.runCommand(runParams()),
      ).rejects.toMatchObject({
        code: "ARCHESTRA_COMMAND_FAILED",
        message,
      });
    }
    expect(native.checkSession).toHaveBeenCalledTimes(1);
    expect(native.runSandbox).not.toHaveBeenCalled();
  });

  test("still reports an unreachable engine as an engine outage", async () => {
    const { sandboxRuntimeService } = await load({ runnerHost: undefined });
    native.runSandbox.mockRejectedValue(
      Object.assign(new Error("connection refused"), {
        code: "ARCHESTRA_ENGINE_UNREACHABLE",
      }),
    );

    await expect(
      sandboxRuntimeService.runCommand(runParams()),
    ).rejects.toMatchObject({
      code: "ARCHESTRA_ENGINE_UNREACHABLE",
      message: "the sandbox runtime is not available (engine unreachable)",
    });
    expect(sandboxRuntimeService.isReady).toBe(false);
  });
});

async function load(params: { runnerHost: string | undefined }) {
  const { default: config } = await import("@/config");
  config.daggerRuntime.enabled = true;
  config.daggerRuntime.runnerHost = params.runnerHost;
  return import("./sandbox-runtime-service");
}

function imagePullError(): Error {
  return Object.assign(new Error(IMAGE_PULL_MESSAGE), {
    code: "ARCHESTRA_SANDBOX_IMAGE_PULL_FAILED",
  });
}

function runParams() {
  return {
    command: "echo hi",
    cwd: "/home/sandbox",
    timeoutSeconds: 5,
    outputBytesLimit: 1024,
    fileSizeLimitBytes: 1024,
    cpuSeconds: 5,
    memoryBytes: 1024 * 1024,
  };
}
