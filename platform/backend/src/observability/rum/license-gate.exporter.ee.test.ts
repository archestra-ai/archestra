import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/config", async () =>
  (await import("@/test/mocks/config")).configModuleMock({
    enterpriseFeatures: { core: false },
    observability: {
      rum: {
        enabled: true,
        logExporter: { url: "http://localhost:4318/v1/logs" },
      },
    },
  }),
);

import { rumExporter } from "./exporter.ee";

describe("rumExporter enterprise gate", () => {
  beforeEach(async () => {
    await rumExporter.shutdown();
  });

  test("a configured endpoint without an enterprise license fails boot loudly", () => {
    expect(() => rumExporter.initialize()).toThrowError(
      /requires an enterprise license/,
    );
    // Nothing was wired: events are acknowledged-and-dropped, not exported.
    expect(rumExporter.emit([], { userId: "user-1" })).toBe(0);
  });
});
