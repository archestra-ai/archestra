import { describe, expect, it } from "vitest";
import {
  estimateFileTokens,
  isTextLikeMediaType,
  TOKEN_ESTIMATE,
} from "./estimate-message-tokens";

describe("isTextLikeMediaType", () => {
  it("classifies text-like media types as true", () => {
    expect(isTextLikeMediaType("text/csv")).toBe(true);
    expect(isTextLikeMediaType("text/plain")).toBe(true);
    expect(isTextLikeMediaType("application/json")).toBe(true);
    expect(isTextLikeMediaType("application/xml")).toBe(true);
  });

  it("classifies binary media types as false", () => {
    expect(isTextLikeMediaType("image/png")).toBe(false);
    expect(isTextLikeMediaType("application/octet-stream")).toBe(false);
    expect(isTextLikeMediaType("application/pdf")).toBe(false);
  });
});

describe("estimateFileTokens branch selection", () => {
  // Byte sizes chosen so each branch yields a numerically distinct result,
  // ensuring the test fails if media-type routing regresses rather than
  // passing on a coincidental equality of the per-token divisors.
  it("routes pdf payloads through pdfBytesPerToken", () => {
    const byteLength = 2_400;
    expect(
      estimateFileTokens({ mediaType: "application/pdf", byteLength }),
    ).toBe(Math.ceil(byteLength / TOKEN_ESTIMATE.pdfBytesPerToken));
    // 2400/12 = 200, distinct from the binary 2400/4 = 600 path below.
    expect(
      estimateFileTokens({ mediaType: "application/pdf", byteLength }),
    ).toBe(200);
  });

  it("routes images through binaryBytesPerToken under the cap", () => {
    const byteLength = 2_400;
    expect(estimateFileTokens({ mediaType: "image/png", byteLength })).toBe(
      Math.ceil(byteLength / TOKEN_ESTIMATE.binaryBytesPerToken),
    );
    expect(estimateFileTokens({ mediaType: "image/png", byteLength })).toBe(
      600,
    );
  });

  it("applies the image token ceiling for large images", () => {
    const byteLength = 8_000;
    const uncapped = Math.ceil(byteLength / TOKEN_ESTIMATE.binaryBytesPerToken);
    expect(uncapped).toBeGreaterThan(TOKEN_ESTIMATE.imageTokenMaxEstimate);
    expect(estimateFileTokens({ mediaType: "image/png", byteLength })).toBe(
      TOKEN_ESTIMATE.imageTokenMaxEstimate,
    );
    // pdf branch for the same byteLength is numerically distinct from the cap.
    expect(
      estimateFileTokens({ mediaType: "application/pdf", byteLength }),
    ).toBe(Math.ceil(byteLength / TOKEN_ESTIMATE.pdfBytesPerToken));
    expect(
      estimateFileTokens({ mediaType: "application/pdf", byteLength }),
    ).not.toBe(TOKEN_ESTIMATE.imageTokenMaxEstimate);
  });

  it("routes text-like payloads through charsPerToken", () => {
    const byteLength = 2_400;
    expect(estimateFileTokens({ mediaType: "text/csv", byteLength })).toBe(
      Math.ceil(byteLength / TOKEN_ESTIMATE.charsPerToken),
    );
  });

  it("routes other binary payloads through binaryBytesPerToken without a cap", () => {
    const byteLength = 8_000;
    expect(
      estimateFileTokens({
        mediaType: "application/octet-stream",
        byteLength,
      }),
    ).toBe(Math.ceil(byteLength / TOKEN_ESTIMATE.binaryBytesPerToken));
    // Above the image cap, proving the non-image binary branch does not clamp.
    expect(
      estimateFileTokens({
        mediaType: "application/octet-stream",
        byteLength,
      }),
    ).toBeGreaterThan(TOKEN_ESTIMATE.imageTokenMaxEstimate);
  });
});
