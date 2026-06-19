import { describe, expect, test } from "vitest";
import {
  appConnectorAudienceRef,
  appIdFromConnectorPath,
  buildConnectorResourceUri,
  canonicalizeConnectorResourceUri,
  connectorWwwAuthenticate,
  isAppConnectorAudienceRef,
  resolveAppConnectorResource,
} from "./app-connector-resource";

const APP_ID = "11111111-1111-1111-1111-111111111111";

describe("canonicalizeConnectorResourceUri", () => {
  test("lowercases the host and strips trailing slash, query, and fragment", () => {
    expect(
      canonicalizeConnectorResourceUri(
        `https://Example.COM/api/mcp/app/${APP_ID}/?x=1#frag`,
      ),
    ).toBe(`https://example.com/api/mcp/app/${APP_ID}`);
  });

  test("drops the default port but keeps a non-default port", () => {
    expect(
      canonicalizeConnectorResourceUri(
        `http://localhost:80/api/mcp/app/${APP_ID}`,
      ),
    ).toBe(`http://localhost/api/mcp/app/${APP_ID}`);
    expect(
      canonicalizeConnectorResourceUri(
        `http://localhost:9000/api/mcp/app/${APP_ID}`,
      ),
    ).toBe(`http://localhost:9000/api/mcp/app/${APP_ID}`);
  });

  test("rejects a non-connector path, a sub-path, a bad scheme, and garbage", () => {
    expect(
      canonicalizeConnectorResourceUri(`https://h/v1/mcp/${APP_ID}`),
    ).toBeNull();
    expect(
      canonicalizeConnectorResourceUri(`https://h/api/mcp/app/${APP_ID}/extra`),
    ).toBeNull();
    expect(
      canonicalizeConnectorResourceUri(`ftp://h/api/mcp/app/${APP_ID}`),
    ).toBeNull();
    expect(canonicalizeConnectorResourceUri("not a url")).toBeNull();
  });
});

describe("resolveAppConnectorResource", () => {
  const allowed = new Set(["https://app.example.com"]);

  test("accepts a connector URI on an allowed origin only", () => {
    expect(
      resolveAppConnectorResource(
        `https://app.example.com/api/mcp/app/${APP_ID}`,
        allowed,
      ),
    ).toBe(`https://app.example.com/api/mcp/app/${APP_ID}`);
    expect(
      resolveAppConnectorResource(
        `https://evil.example.com/api/mcp/app/${APP_ID}`,
        allowed,
      ),
    ).toBeNull();
    expect(resolveAppConnectorResource(undefined, allowed)).toBeNull();
  });
});

describe("appConnectorAudienceRef / isAppConnectorAudienceRef", () => {
  test("a built ref is recognized; other prefixes and null are not", () => {
    const ref = appConnectorAudienceRef(`https://h/api/mcp/app/${APP_ID}`);
    expect(ref).toBe(`mcp-app-resource:https://h/api/mcp/app/${APP_ID}`);
    expect(isAppConnectorAudienceRef(ref)).toBe(true);
    expect(isAppConnectorAudienceRef("mcp-resource:abc")).toBe(false);
    expect(isAppConnectorAudienceRef("mcp-oauth-client:abc")).toBe(false);
    expect(isAppConnectorAudienceRef(null)).toBe(false);
  });
});

describe("buildConnectorResourceUri", () => {
  test("builds and canonicalizes from an origin and appId", () => {
    expect(buildConnectorResourceUri("https://Host", APP_ID)).toBe(
      `https://host/api/mcp/app/${APP_ID}`,
    );
  });
});

describe("connectorWwwAuthenticate", () => {
  test("points at the protected-resource metadata and requests the mcp scope", () => {
    expect(connectorWwwAuthenticate("https://host", APP_ID)).toBe(
      `Bearer resource_metadata="https://host/.well-known/oauth-protected-resource/api/mcp/app/${APP_ID}", scope="mcp"`,
    );
  });
});

describe("appIdFromConnectorPath", () => {
  test("extracts the appId from a connector path, with or without a query", () => {
    expect(appIdFromConnectorPath(`/api/mcp/app/${APP_ID}`)).toBe(APP_ID);
    expect(appIdFromConnectorPath(`/api/mcp/app/${APP_ID}?x=1`)).toBe(APP_ID);
  });

  test("returns null for a non-connector path or an empty id", () => {
    expect(appIdFromConnectorPath("/api/apps")).toBeNull();
    expect(appIdFromConnectorPath("/api/mcp/app/")).toBeNull();
  });
});
