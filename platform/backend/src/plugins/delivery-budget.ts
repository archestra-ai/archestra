import {
  PLUGIN_DELIVERY_MAX_BYTES,
  PLUGIN_DELIVERY_MAX_COUNT,
  type PluginFileEncoding,
} from "@/types";

interface PluginDeliveryStats {
  pluginCount: number;
  totalBytes: number;
}

export function computePluginDeliveryStats(
  plugins: readonly {
    files: readonly { content: string; encoding: PluginFileEncoding }[];
  }[],
): PluginDeliveryStats {
  return {
    pluginCount: plugins.length,
    totalBytes: plugins.reduce(
      (total, plugin) =>
        total +
        plugin.files.reduce(
          (pluginTotal, file) =>
            pluginTotal +
            (file.encoding === "base64"
              ? Buffer.from(file.content, "base64").length
              : Buffer.byteLength(file.content, "utf8")),
          0,
        ),
      0,
    ),
  };
}

export function pluginDeliveryBudgetError(
  stats: PluginDeliveryStats,
): string | null {
  if (stats.pluginCount > PLUGIN_DELIVERY_MAX_COUNT) {
    return `Plugin delivery is limited to ${PLUGIN_DELIVERY_MAX_COUNT} plugins`;
  }
  if (stats.totalBytes > PLUGIN_DELIVERY_MAX_BYTES) {
    return `Plugin delivery exceeds ${PLUGIN_DELIVERY_MAX_BYTES} decoded bytes`;
  }
  return null;
}
