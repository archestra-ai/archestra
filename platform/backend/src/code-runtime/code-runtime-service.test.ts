import { afterEach, describe, expect, test, vi } from "@/test";
import { codeRuntimeService } from "./code-runtime-service";
import { CodeRuntimeError } from "./types";

describe("codeRuntimeService", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  test("is disabled when ARCHESTRA_CODE_RUNTIME_ENABLED is unset", () => {
    expect(codeRuntimeService.isEnabled).toBe(false);
    expect(codeRuntimeService.isReady).toBe(false);
  });

  test("run() rejects with CodeRuntimeError while the runtime is disabled", async () => {
    await expect(
      codeRuntimeService.run({ code: "print('hello')" }),
    ).rejects.toBeInstanceOf(CodeRuntimeError);
  });

  test.each([
    0,
    -1,
    1.5,
    Number.NaN,
  ])("run() rejects invalid timeoutSeconds=%s before initializing", async (timeoutSeconds) => {
    vi.resetModules();
    vi.stubEnv("ARCHESTRA_CODE_RUNTIME_ENABLED", "true");
    vi.stubEnv(
      "ARCHESTRA_CODE_RUNTIME_DAGGER_RUNNER_HOST",
      "tcp://dagger-runtime.dagger.svc.cluster.local:1234",
    );
    const { codeRuntimeService: enabledCodeRuntimeService } = await import(
      "./code-runtime-service"
    );

    await expect(
      enabledCodeRuntimeService.run({ code: "print('hello')", timeoutSeconds }),
    ).rejects.toThrow("timeoutSeconds must");
  });
});
