import { describe, expect, test } from "vitest";
import type { InternalMcpCatalog } from "@/types";
import { applyPresetHeaderMappings } from "./mcp-client";

/**
 * Runtime equivalence contract:
 *
 *   Plaintext preset value in `preset_field_values` jsonb AND
 *   secret preset value materialized into `preset_field_values` by the
 *   catalog read path (which merges `preset_secret_id`'s bag into
 *   `preset_field_values` before handing the row to the runtime)
 *
 *   → produce IDENTICAL outgoing headers.
 *
 * This is what makes the storage choice (plaintext vs secret bag) invisible
 * to the rest of the system: by the time `applyPresetHeaderMappings` runs,
 * both shapes look the same.
 */
describe("applyPresetHeaderMappings — storage-source equivalence", () => {
  function makeCatalogWithHeader(
    fieldKey: string,
    headerName: string,
    sensitive: boolean,
    presetFieldValues: Record<string, string>,
    extras?: { valuePrefix?: string; defaultValue?: string },
  ): InternalMcpCatalog {
    // Minimal shape — applyPresetHeaderMappings only inspects userConfig +
    // presetFieldValues. Cast to InternalMcpCatalog because we don't need
    // every column to test this pure-ish helper.
    return {
      userConfig: {
        [fieldKey]: {
          type: "string",
          title: headerName,
          description: "",
          promptOnPreset: true,
          required: false,
          sensitive,
          headerName,
          ...(extras?.valuePrefix ? { valuePrefix: extras.valuePrefix } : {}),
          ...(extras?.defaultValue !== undefined
            ? { default: extras.defaultValue }
            : {}),
        },
      },
      presetFieldValues,
    } as unknown as InternalMcpCatalog;
  }

  test("plaintext-origin and secret-origin preset values produce identical headers", () => {
    // Catalog A — non-sensitive: value sits in preset_field_values jsonb
    // directly.
    const plaintextCatalog = makeCatalogWithHeader(
      "api_key",
      "x-api-key",
      false,
      { api_key: "value-001" },
    );

    // Catalog B — sensitive: value originally lived in the preset secret
    // bag at preset_secret_id. By the time it reaches the runtime, the
    // catalog read path has merged it into presetFieldValues so the
    // runtime sees one unified map. We simulate that merged state here.
    const secretOriginCatalog = makeCatalogWithHeader(
      "api_key",
      "x-api-key",
      true,
      { api_key: "value-001" },
    );

    const headersFromPlaintext: Record<string, string> = {};
    applyPresetHeaderMappings(headersFromPlaintext, plaintextCatalog);

    const headersFromSecret: Record<string, string> = {};
    applyPresetHeaderMappings(headersFromSecret, secretOriginCatalog);

    expect(headersFromPlaintext).toEqual({ "x-api-key": "value-001" });
    expect(headersFromSecret).toEqual(headersFromPlaintext);
  });

  test("`valuePrefix` is applied identically regardless of value origin", () => {
    const plaintextCatalog = makeCatalogWithHeader(
      "token",
      "authorization",
      false,
      { token: "abc.def" },
      { valuePrefix: "Bearer " },
    );
    const secretOriginCatalog = makeCatalogWithHeader(
      "token",
      "authorization",
      true,
      { token: "abc.def" },
      { valuePrefix: "Bearer " },
    );

    const a: Record<string, string> = {};
    applyPresetHeaderMappings(a, plaintextCatalog);
    const b: Record<string, string> = {};
    applyPresetHeaderMappings(b, secretOriginCatalog);

    expect(a).toEqual({ authorization: "Bearer abc.def" });
    expect(b).toEqual(a);
  });

  test("preset value overwrites any header previously written by earlier passes", () => {
    // Mirrors the doc-comment contract: preset values are the authoritative
    // source for `promptOnPreset` fields. If buildStaticCredentialHeaders
    // or any other earlier pass put a value under the same header name,
    // the preset value replaces it.
    const catalog = makeCatalogWithHeader("api_key", "x-api-key", true, {
      api_key: "preset-overrides",
    });

    const headers: Record<string, string> = {
      "x-api-key": "earlier-pass-value",
    };
    applyPresetHeaderMappings(headers, catalog);

    expect(headers).toEqual({ "x-api-key": "preset-overrides" });
  });

  test("falls back to field.default when presetFieldValues lacks the key", () => {
    // The function reads `presetFieldValues[key] ?? field.default`. Default
    // values flow regardless of sensitive flag.
    const plaintextCatalog = makeCatalogWithHeader(
      "region",
      "x-region",
      false,
      {},
      { defaultValue: "us-east-1" },
    );
    const secretOriginCatalog = makeCatalogWithHeader(
      "region",
      "x-region",
      true,
      {},
      { defaultValue: "us-east-1" },
    );

    const a: Record<string, string> = {};
    applyPresetHeaderMappings(a, plaintextCatalog);
    const b: Record<string, string> = {};
    applyPresetHeaderMappings(b, secretOriginCatalog);

    expect(a).toEqual({ "x-region": "us-east-1" });
    expect(b).toEqual(a);
  });

  test("skips fields without promptOnPreset (those are not preset-scoped)", () => {
    const catalog = {
      userConfig: {
        // promptOnInstallation, not promptOnPreset — should be ignored here.
        per_install: {
          type: "string",
          title: "x-per-install",
          description: "",
          promptOnInstallation: true,
          required: false,
          sensitive: true,
          headerName: "x-per-install",
        },
        // Static — no prompt flags — should be ignored here too.
        static_field: {
          type: "string",
          title: "x-static",
          description: "",
          required: false,
          sensitive: false,
          headerName: "x-static",
          default: "static-val",
        },
      },
      // Even if presetFieldValues has a value, the field isn't preset-scoped
      // so applyPresetHeaderMappings must not write the header.
      presetFieldValues: { per_install: "ignored", static_field: "ignored" },
    } as unknown as InternalMcpCatalog;

    const headers: Record<string, string> = {};
    applyPresetHeaderMappings(headers, catalog);
    expect(headers).toEqual({});
  });
});
