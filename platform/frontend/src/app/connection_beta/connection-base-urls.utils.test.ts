import { describe, expect, it } from "vitest";
import {
  applyDefaultBaseUrl,
  applyVisibility,
  buildBaseUrlMeta,
  collapseBaseUrlMeta,
  resolveDefaultBaseUrl,
} from "./connection-base-urls.utils";

describe("connection-base-urls.utils", () => {
  describe("resolveDefaultBaseUrl", () => {
    it("returns the URL marked default when it is in env", () => {
      const meta = buildBaseUrlMeta([
        { url: "https://b", description: "", isDefault: true, visible: true },
      ]);
      expect(resolveDefaultBaseUrl(["https://a", "https://b"], meta)).toBe(
        "https://b",
      );
    });

    it("falls back to the first env URL when nothing is marked default", () => {
      expect(resolveDefaultBaseUrl(["https://a", "https://b"], {})).toBe(
        "https://a",
      );
    });

    // Env is the only source of truth: a stored default that is no longer in
    // env must NOT leak through anywhere in the UI.
    it("ignores a stored default that is no longer in env", () => {
      const meta = buildBaseUrlMeta([
        {
          url: "https://stale",
          description: "",
          isDefault: true,
          visible: true,
        },
      ]);
      expect(resolveDefaultBaseUrl(["https://a", "https://b"], meta)).toBe(
        "https://a",
      );
    });

    it("returns null when env has no URLs at all", () => {
      expect(resolveDefaultBaseUrl([], {})).toBeNull();
    });
  });

  describe("applyDefaultBaseUrl", () => {
    it("marks the selected URL as default and clears every other flag", () => {
      const next = applyDefaultBaseUrl(
        ["https://a", "https://b", "https://c"],
        {
          "https://a": { description: "", isDefault: true, visible: true },
        },
        "https://c",
      );
      expect(next["https://a"].isDefault).toBe(false);
      expect(next["https://b"].isDefault).toBe(false);
      expect(next["https://c"].isDefault).toBe(true);
    });

    // Regression: a stored default for a URL that has since been removed from
    // env must not block the admin from picking a different default.
    it("lets the admin mark another URL as default when the stored default is stale", () => {
      const stored = buildBaseUrlMeta([
        {
          url: "https://stale",
          description: "old endpoint",
          isDefault: true,
          visible: true,
        },
        { url: "https://b", description: "", isDefault: false, visible: true },
      ]);
      const next = applyDefaultBaseUrl(
        ["https://a", "https://b"],
        stored,
        "https://b",
      );
      expect(next["https://b"].isDefault).toBe(true);
      expect(next).not.toHaveProperty("https://stale");
    });

    it("preserves description and visibility for env URLs when picking a default", () => {
      const stored = buildBaseUrlMeta([
        {
          url: "https://a",
          description: "Office",
          isDefault: false,
          visible: false,
        },
      ]);
      const next = applyDefaultBaseUrl(
        ["https://a", "https://b"],
        stored,
        "https://b",
      );
      expect(next["https://a"].description).toBe("Office");
      expect(next["https://a"].visible).toBe(false);
    });
  });

  describe("collapseBaseUrlMeta", () => {
    // Env is the source of truth on save, too: stale entries from a previous
    // env config must never make it back to the database.
    it("drops stored entries whose URL is no longer in env", () => {
      const stored = buildBaseUrlMeta([
        {
          url: "https://stale",
          description: "old",
          isDefault: true,
          visible: true,
        },
        {
          url: "https://b",
          description: "VPN",
          isDefault: false,
          visible: true,
        },
      ]);
      const collapsed = collapseBaseUrlMeta(["https://a", "https://b"], stored);
      expect(collapsed).toEqual([
        {
          url: "https://b",
          description: "VPN",
          isDefault: false,
          visible: true,
        },
      ]);
    });

    it("returns null when nothing meaningful is stored", () => {
      const stored = buildBaseUrlMeta([
        {
          url: "https://a",
          description: "",
          isDefault: false,
          visible: true,
        },
      ]);
      expect(collapseBaseUrlMeta(["https://a"], stored)).toBeNull();
    });

    it("clears the default flag when a URL is hidden", () => {
      const stored: Record<
        string,
        { description: string; isDefault: boolean; visible: boolean }
      > = {
        "https://a": {
          description: "",
          isDefault: true,
          visible: false,
        },
      };
      const collapsed = collapseBaseUrlMeta(["https://a"], stored);
      expect(collapsed?.[0].isDefault).toBe(false);
    });
  });

  describe("applyVisibility", () => {
    it("clears the default flag when a URL is hidden", () => {
      const next = applyVisibility(
        {
          "https://a": { description: "", isDefault: true, visible: true },
        },
        "https://a",
        false,
      );
      expect(next["https://a"].isDefault).toBe(false);
      expect(next["https://a"].visible).toBe(false);
    });

    it("keeps the default flag when re-showing a non-default URL", () => {
      const next = applyVisibility(
        {
          "https://a": { description: "", isDefault: false, visible: false },
        },
        "https://a",
        true,
      );
      expect(next["https://a"].isDefault).toBe(false);
      expect(next["https://a"].visible).toBe(true);
    });
  });
});
