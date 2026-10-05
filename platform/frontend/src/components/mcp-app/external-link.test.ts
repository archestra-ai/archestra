// @vitest-environment node
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

  test("keeps Slack message and thread anchors", () => {
    expect(
      normalizeMcpAppExternalUrl(
        "slack://channel?team=T123ABC456&id=C123ABC456&message=1790957997.011019&thread_ts=1790957996.547529",
      ),
    ).toBe(
      "slack://channel?team=T123ABC456&id=C123ABC456&message=1790957997.011019&thread_ts=1790957996.547529",
    );
  });

  test("drops malformed Slack anchors", () => {
    expect(
      normalizeMcpAppExternalUrl(
        "slack://channel?team=T123ABC456&id=C123ABC456&message=x&thread_ts=1.2",
      ),
    ).toBe("slack://channel?team=T123ABC456&id=C123ABC456");
    expect(
      normalizeMcpAppExternalUrl(
        "slack://channel?team=T123ABC456&id=C123ABC456&message=1.2&thread_ts=evil",
      ),
    ).toBe("slack://channel?team=T123ABC456&id=C123ABC456&message=1.2");
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
