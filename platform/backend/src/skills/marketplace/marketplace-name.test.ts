import { describe, expect, test } from "vitest";
import { bundleMarketplaceNameFor } from "./marketplace-name";

describe("bundleMarketplaceNameFor", () => {
  test("is stable across content kinds and keeps each full Bundle ID suffix", () => {
    const organization = {
      appName: "A very long branded application name that would otherwise consume the entire marketplace identity",
      slug: "an-equally-long-organization-slug-for-the-same-marketplace",
      name: "Ignored organization name",
    };
    const firstId = "11111111-2222-4333-8444-555555555555";
    const secondId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

    const first = bundleMarketplaceNameFor({
      organizationId: "org-id",
      bundleId: firstId,
      organization,
    });
    const sameBundleAfterContentChange = bundleMarketplaceNameFor({
      organizationId: "org-id",
      bundleId: firstId,
      organization,
    });
    const second = bundleMarketplaceNameFor({
      organizationId: "org-id",
      bundleId: secondId,
      organization,
    });

    expect(first).toBe(sameBundleAfterContentChange);
    expect(first).not.toBe(second);
    expect(first.length).toBeLessThanOrEqual(64);
    expect(first.endsWith(`bundle-${firstId}`)).toBe(true);
    expect(second.endsWith(`bundle-${secondId}`)).toBe(true);
  });
});
