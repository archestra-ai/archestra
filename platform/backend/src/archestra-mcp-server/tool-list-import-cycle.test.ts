import { getArchestraToolFullName } from "@archestra/shared";
import { describe, expect, test, vi } from "vitest";

// Puts this file in the isolated vitest project (see vitest.config.ts: files
// touching the mock registry get `isolate: true`). `resetModules` below would
// otherwise clear the module registry the clean project's worker shares with
// every other file, failing whichever siblings happen to be mid-run.
vi.mock("@/logging");

/**
 * `./index` is part of an import cycle: `./sandbox` imports `@/models`, which
 * reaches `models/agent` → `clients/chat-mcp-client` → back to `./index`.
 * Entering through `./sandbox` runs `./index`'s body while the group modules it
 * aggregates are still uninitialized, so anything `./index` builds from them at
 * module scope reads `undefined`.
 *
 * Only one of the two aggregations fails loudly, which is why this pins both:
 * spreading the tool arrays throws `tools is not iterable`, while spreading the
 * tool-entry objects silently yields a dispatch map missing whole groups.
 *
 * Import order alone decides whether either surfaces, so `resetModules` fixes
 * the order that breaks rather than leaving it to which file loaded first.
 */
describe("built-in aggregations under the @/models import cycle", () => {
  test("tool lists survive the cycle entered through ./sandbox", async () => {
    vi.resetModules();

    await import("./sandbox");
    const index = await import(".");

    expect(index.getAllArchestraMcpTools().length).toBeGreaterThan(0);
    expect(index.getArchestraMcpTools().length).toBeGreaterThan(0);
  });

  test("the dispatch map still resolves a sandbox tool's schema", async () => {
    vi.resetModules();

    await import("./sandbox");
    const index = await import(".");

    // Resolved through the tool-entry map, so an incomplete one returns
    // undefined here instead of failing anywhere the model can see.
    expect(
      index.getArchestraToolInputSchema(
        getArchestraToolFullName("run_command"),
      ),
    ).toBeDefined();
  });
});
