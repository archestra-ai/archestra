import { describe, expect, it } from "vitest";
import { PLUGIN_DELIVERY_MAX_BYTES, PLUGIN_DELIVERY_MAX_COUNT } from "@/types";
import {
  computePluginDeliveryStats,
  pluginDeliveryBudgetError,
} from "./delivery-budget";

describe("Plugin delivery budget", () => {
  it("counts decoded UTF-8 and base64 bytes", () => {
    expect(
      computePluginDeliveryStats([
        {
          files: [
            { content: "€", encoding: "utf8" },
            {
              content: Buffer.from("four").toString("base64"),
              encoding: "base64",
            },
          ],
        },
      ]),
    ).toEqual({ pluginCount: 1, totalBytes: 7 });
  });

  it("accepts a delivery at both limits", () => {
    expect(
      pluginDeliveryBudgetError({
        pluginCount: 555,
        totalBytes: 1110 * 1024 * 1024,
      }),
    ).toBeNull();
  });

  it("rejects count and aggregate-byte overages in readable units", () => {
    expect(
      pluginDeliveryBudgetError({
        pluginCount: PLUGIN_DELIVERY_MAX_COUNT + 1,
        totalBytes: 0,
      }),
    ).toBe("Plugin delivery is limited to 555 plugins");
    expect(
      pluginDeliveryBudgetError({
        pluginCount: 1,
        totalBytes: PLUGIN_DELIVERY_MAX_BYTES + 1,
      }),
    ).toBe("Plugin delivery is limited to 1110 MiB of plugin files");
  });
});
