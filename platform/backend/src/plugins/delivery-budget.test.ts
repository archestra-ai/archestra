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

  it("rejects count and aggregate-byte overages", () => {
    expect(
      pluginDeliveryBudgetError({
        pluginCount: PLUGIN_DELIVERY_MAX_COUNT + 1,
        totalBytes: 0,
      }),
    ).toContain(`${PLUGIN_DELIVERY_MAX_COUNT}`);
    expect(
      pluginDeliveryBudgetError({
        pluginCount: 1,
        totalBytes: PLUGIN_DELIVERY_MAX_BYTES + 1,
      }),
    ).toContain(`${PLUGIN_DELIVERY_MAX_BYTES}`);
  });
});
