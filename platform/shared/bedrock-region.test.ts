import { describe, expect, it } from "vitest";
import {
  BEDROCK_REGIONS,
  bedrockRegionFromBaseUrl,
  bedrockRuntimeBaseUrl,
  DEFAULT_BEDROCK_REGION,
} from "./model-constants";

describe("bedrockRuntimeBaseUrl", () => {
  it("builds the runtime endpoint for a region", () => {
    expect(bedrockRuntimeBaseUrl("eu-central-1")).toBe(
      "https://bedrock-runtime.eu-central-1.amazonaws.com",
    );
  });

  it("round-trips every region the picker offers", () => {
    // The key form stores a region by writing this URL and reads it back with
    // the parser below; a region that failed to round-trip would silently run
    // against the fallback region instead.
    for (const { id } of BEDROCK_REGIONS) {
      expect(bedrockRegionFromBaseUrl(bedrockRuntimeBaseUrl(id))).toBe(id);
    }
  });

  it("offers the default region", () => {
    expect(
      BEDROCK_REGIONS.some(({ id }) => id === DEFAULT_BEDROCK_REGION),
    ).toBe(true);
  });
});

describe("bedrockRegionFromBaseUrl", () => {
  it("reads the region out of a runtime endpoint", () => {
    expect(
      bedrockRegionFromBaseUrl(
        "https://bedrock-runtime.us-west-2.amazonaws.com",
      ),
    ).toBe("us-west-2");
  });

  it("reads the region out of a VPC endpoint that embeds the runtime host", () => {
    expect(
      bedrockRegionFromBaseUrl(
        "https://vpce-0abc-xyz.bedrock-runtime.eu-west-1.vpce.amazonaws.com",
      ),
    ).toBe("eu-west-1");
  });

  it("returns null for the control-plane host", () => {
    // bedrock.<region> is the control plane, not the runtime. Matching it would
    // resurrect the trap where a plausible-looking endpoint resolves elsewhere.
    expect(
      bedrockRegionFromBaseUrl("https://bedrock.us-east-2.amazonaws.com"),
    ).toBeNull();
  });

  it("returns null for an endpoint with no region", () => {
    expect(
      bedrockRegionFromBaseUrl("https://my-bedrock-gateway.internal/v1"),
    ).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(bedrockRegionFromBaseUrl(null)).toBeNull();
    expect(bedrockRegionFromBaseUrl(undefined)).toBeNull();
    expect(bedrockRegionFromBaseUrl("")).toBeNull();
  });
});
