import { describe, expect, test } from "vitest";
import { normalizeMcpAppExternalUrl } from "./external-link";

describe("normalizeMcpAppExternalUrl", () => {
  test("allows web links", () => {
    expect(normalizeMcpAppExternalUrl("https://example.com/path?q=1")).toBe(
      "https://example.com/path?q=1",
    );
  });

  test("allows canonical Slack desktop channel links", () => {
    expect(
      normalizeMcpAppExternalUrl(
        "slack://channel?team=T123ABC456&id=C123ABC456",
      ),
    ).toBe("slack://channel?team=T123ABC456&id=C123ABC456");
  });

  test("rejects other Slack desktop actions", () => {
    expect(
      normalizeMcpAppExternalUrl("slack://open?team=T123ABC456"),
    ).toBeNull();
    expect(
      normalizeMcpAppExternalUrl(
        "slack://channel?team=not-a-team&id=C123ABC456",
      ),
    ).toBeNull();
  });

  test("rejects executable and malformed URLs", () => {
    expect(normalizeMcpAppExternalUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeMcpAppExternalUrl("not a URL")).toBeNull();
  });
});
