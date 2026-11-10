import { asRecord } from "@/utils/as-record";

/**
 * Advertise the protected transport's capabilities, not every vendor feature.
 * Grok couples hosted web search and x_search under this one capability. The
 * latter has no governed output binding here, so it must not be offered.
 * Do this at discovery rather than silently dropping declared request tools.
 */
export function grokCatalogForProxy(
  catalog: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...catalog };
  for (const key of ["data", "models"]) {
    const models = catalog[key];
    if (!Array.isArray(models)) continue;
    result[key] = models.map((value) => {
      const model = asRecord(value);
      if (!model) return value;
      const meta = asRecord(model._meta);
      return {
        ...model,
        supportsBackendSearch: false,
        supports_backend_search: false,
        ...(meta
          ? {
              _meta: {
                ...meta,
                supportsBackendSearch: false,
                supports_backend_search: false,
              },
            }
          : {}),
      };
    });
  }
  return result;
}
