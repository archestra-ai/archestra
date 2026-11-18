import { afterEach, describe, expect, test } from "vitest";
import config from "@/config";
import { signSiteToken, verifySiteToken } from "./channel-auth";

describe("site tokens", () => {
  const body = JSON.stringify({ hello: "gcp" });
  const now = Date.UTC(2026, 10, 16, 12, 0, 0);

  afterEach(() => {
    config.site.name = "default";
  });

  test("a token for this site over this body verifies and names its sender", () => {
    const token = signSiteToken({ to: "gcp-us", body, from: "azure-us", now });
    config.site.name = "gcp-us";
    expect(verifySiteToken({ token, body, now })).toEqual({
      ok: true,
      from: "azure-us",
    });
  });

  test("is refused for another site, another body, or once expired", () => {
    const token = signSiteToken({ to: "gcp-us", body, from: "azure-us", now });
    config.site.name = "gcp-eu";
    expect(verifySiteToken({ token, body, now })).toMatchObject({ ok: false });
    config.site.name = "gcp-us";
    expect(verifySiteToken({ token, body: `${body} `, now })).toMatchObject({
      ok: false,
      reason: "site token does not match the request body",
    });
    expect(verifySiteToken({ token, body, now: now + 120_000 })).toMatchObject({
      ok: false,
      reason: "site token expired",
    });
  });

  test("is refused when signed with another auth secret", () => {
    const token = signSiteToken({ to: "gcp-us", body, from: "azure-us", now });
    const secret = config.auth.secret;
    config.auth.secret = "another-secret-another-secret-another";
    config.site.name = "gcp-us";
    try {
      expect(verifySiteToken({ token, body, now })).toMatchObject({
        ok: false,
      });
    } finally {
      config.auth.secret = secret;
    }
  });
});
