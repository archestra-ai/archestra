import type { archestraApiTypes } from "@shared";

export type CatalogItem =
  archestraApiTypes.GetInternalMcpCatalogResponses["200"][number];

export type FieldScope = "static" | "preset" | "user";

export function fieldScope(field: {
  promptOnInstallation?: boolean;
  promptOnPreset?: boolean;
}): FieldScope {
  if (field.promptOnInstallation) return "user";
  if (field.promptOnPreset) return "preset";
  return "static";
}

export type FieldValueType = "string" | "number" | "boolean";

export type CatalogFieldEntry = {
  key: string;
  origin: "userConfig" | "envVar";
  scope: FieldScope;
  required: boolean;
  title?: string;
  description?: string;
  /** Only set for userConfig fields. When present on every userConfig field, the install form labels the section "Additional Headers" instead of "Connection Settings". */
  headerName?: string;
  /** True for env vars with type=secret or userConfig fields with sensitive=true. */
  secret: boolean;
  valueType: FieldValueType;
};

export function listCatalogFields(cat: CatalogItem): CatalogFieldEntry[] {
  const entries: CatalogFieldEntry[] = [];
  for (const [key, field] of Object.entries(cat.userConfig ?? {})) {
    entries.push({
      key,
      origin: "userConfig",
      scope: fieldScope(field),
      required: field.required ?? false,
      title: field.title,
      description: field.description,
      headerName: field.headerName,
      secret: !!field.sensitive,
      valueType:
        field.type === "boolean"
          ? "boolean"
          : field.type === "number"
            ? "number"
            : "string",
    });
  }
  for (const env of cat.localConfig?.environment ?? []) {
    entries.push({
      key: env.key,
      origin: "envVar",
      scope: fieldScope(env),
      required: env.required ?? false,
      description: env.description,
      secret: env.type === "secret",
      valueType:
        env.type === "boolean"
          ? "boolean"
          : env.type === "number"
            ? "number"
            : "string",
    });
  }
  return entries;
}

export function presetFieldKeys(cat: CatalogItem): string[] {
  return listCatalogFields(cat)
    .filter((f) => f.scope === "preset")
    .map((f) => f.key);
}
