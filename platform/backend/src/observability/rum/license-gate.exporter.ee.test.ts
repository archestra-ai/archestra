import { beforeEach, describe, expect, test } from "vitest";
import config from "@/config";
import { rumExporter } from "./exporter.ee";

describe("rumExporter enterprise gate", () => {
  beforeEach(async () => {
    config.enterpriseFeatures.core = false;
    config.observability.rum.enabled = true;
    config.observability.rum.logExporter.url = "http://localhost:4318/v1/logs";
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
