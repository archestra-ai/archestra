import { DocsPage, getDocsUrl } from "@shared";
import { describe, expect, it, vi } from "vitest";

const mockConfig = {
  enterpriseFeatures: {
    fullWhiteLabeling: false,
  },
};

vi.mock("@/lib/config/config", () => ({
  default: new Proxy(
    {},
    {
      get: (_target, prop) =>
        prop in mockConfig
          ? mockConfig[prop as keyof typeof mockConfig]
          : undefined,
    },
  ),
}));

import { getFrontendDocsUrl, getVisibleDocsUrl } from "./docs";

describe("docs helpers", () => {
  it("returns a docs URL when full white-labeling is disabled", () => {
    mockConfig.enterpriseFeatures.fullWhiteLabeling = false;

    expect(getFrontendDocsUrl(DocsPage.PlatformQuickstart)).toBe(
      getDocsUrl(DocsPage.PlatformQuickstart),
    );
  });

  it("hides frontend docs URLs when full white-labeling is enabled", () => {
    mockConfig.enterpriseFeatures.fullWhiteLabeling = true;

    expect(getFrontendDocsUrl(DocsPage.PlatformQuickstart)).toBeNull();
  });

  it("hides Archestra-hosted links when full white-labeling is enabled", () => {
    mockConfig.enterpriseFeatures.fullWhiteLabeling = true;

    expect(getVisibleDocsUrl("https://archestra.ai/docs/page")).toBeNull();
  });

  it("preserves non-Archestra links when full white-labeling is enabled", () => {
    mockConfig.enterpriseFeatures.fullWhiteLabeling = true;

    expect(getVisibleDocsUrl("https://example.com/docs/page")).toBe(
      "https://example.com/docs/page",
    );
  });

  it("returns null for empty visible docs URLs", () => {
    expect(getVisibleDocsUrl(null)).toBeNull();
    expect(getVisibleDocsUrl(undefined)).toBeNull();
  });
});
