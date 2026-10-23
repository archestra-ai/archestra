import { expect, test } from "vitest";
import { nativeSetupClientFromProvenance } from "./connection-setup-scope";

test("maps native client provenance, and nothing else, to a client", () => {
  expect(nativeSetupClientFromProvenance("claude-code-header")).toBe(
    "claude-code",
  );
  expect(nativeSetupClientFromProvenance("codex-turn-metadata")).toBe("codex");
  expect(nativeSetupClientFromProvenance("pi-session-header")).toBe("pi");
  expect(nativeSetupClientFromProvenance("kilo-session-header")).toBe("kilo");
  expect(nativeSetupClientFromProvenance("kilo-hosted-header")).toBe("kilo");
  for (const provenance of [
    "claude-metadata",
    "prompt-cache-key",
    "appa-header",
  ] as const) {
    expect(nativeSetupClientFromProvenance(provenance)).toBeUndefined();
  }
});
