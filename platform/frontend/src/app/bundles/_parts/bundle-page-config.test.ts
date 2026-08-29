import { describe, expect, it } from "vitest";
import {
  bundleConnectionHref,
  bundleDetailHref,
  bundleEditHref,
  resolveBundleStep,
} from "./bundle-page-config";

describe("bundle page routes", () => {
  it("encodes bundle IDs in detail and edit links", () => {
    expect(bundleDetailHref("id/with spaces")).toBe(
      "/bundles/id%2Fwith%20spaces",
    );
    expect(bundleEditHref("id/with spaces", "capabilities")).toBe(
      "/bundles/id%2Fwith%20spaces/edit?step=capabilities",
    );
    expect(bundleConnectionHref("id/with spaces")).toBe(
      "/connection?bundleId=id%2Fwith%20spaces",
    );
  });

  it("falls back to the details step", () => {
    expect(resolveBundleStep("capabilities")).toBe("capabilities");
    expect(resolveBundleStep("unknown")).toBe("details");
  });
});
