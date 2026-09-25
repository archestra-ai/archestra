import { describe, expect, test } from "vitest";
import {
  appConnectorAudienceRef,
  appIdFromConnectorPath,
  buildConnectorResourceUri,
  canonicalizeConnectorResourceUri,
  connectorResourceUriFromAudienceRef,
  connectorWwwAuthenticate,
  isAppConnectorAudienceRef,
  isConnectorTargetedResource,
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

  test("matches an allowed origin that differs only by host case or default port", () => {
    // allowedOrigins are request-derived and may carry a mixed-case host or an
    // explicit :443; the canonical origin is lowercased/port-stripped. Both must
    // be normalized before compare, or a valid resource is wrongly rejected.
    const messyAllowed = new Set([
      "https://App.Example.com:443",
      "HTTP://Localhost:80",
    ]);
    expect(
      resolveAppConnectorResource(
        `https://app.example.com/api/mcp/app/${APP_ID}`,
        messyAllowed,
      ),
    ).toBe(`https://app.example.com/api/mcp/app/${APP_ID}`);
    expect(
      resolveAppConnectorResource(
        `http://localhost/api/mcp/app/${APP_ID}`,
        messyAllowed,
      ),
    ).toBe(`http://localhost/api/mcp/app/${APP_ID}`);
  });
});

describe("isConnectorTargetedResource", () => {
  test("true for any /api/mcp/app/ path, even an untrusted origin or sub-path", () => {
    expect(
      isConnectorTargetedResource(
        `https://app.example.com/api/mcp/app/${APP_ID}`,
      ),
    ).toBe(true);
    // The cases resolveAppConnectorResource rejects but which must still fail
    // closed rather than mint an unbound token.
    expect(
      isConnectorTargetedResource(
        `https://evil.example.com/api/mcp/app/${APP_ID}`,
      ),
    ).toBe(true);
    expect(
      isConnectorTargetedResource(
        `https://app.example.com/api/mcp/app/${APP_ID}/extra`,
      ),
    ).toBe(true);
  });

  test("false for an absent or non-connector resource", () => {
    expect(isConnectorTargetedResource(undefined)).toBe(false);
    expect(isConnectorTargetedResource("")).toBe(false);
    expect(isConnectorTargetedResource("not a url")).toBe(false);
    expect(
      isConnectorTargetedResource("https://app.example.com/api/mcp/gateway/x"),
    ).toBe(false);
    expect(isConnectorTargetedResource("https://app.example.com/")).toBe(false);
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

describe("connectorResourceUriFromAudienceRef", () => {
  test("round-trips a connector audience ref back to its canonical URI", () => {
    const uri = `https://host/api/mcp/app/${APP_ID}`;
    expect(
      connectorResourceUriFromAudienceRef(appConnectorAudienceRef(uri)),
    ).toBe(uri);
  });

  test("returns null for a non-connector ref or absent value", () => {
    expect(connectorResourceUriFromAudienceRef("mcp-resource:abc")).toBeNull();
    expect(
      connectorResourceUriFromAudienceRef("mcp-oauth-client:abc"),
    ).toBeNull();
    expect(connectorResourceUriFromAudienceRef("not-a-ref")).toBeNull();
    expect(connectorResourceUriFromAudienceRef("mcp-app-resource:")).toBeNull();
    expect(connectorResourceUriFromAudienceRef(null)).toBeNull();
    expect(connectorResourceUriFromAudienceRef(undefined)).toBeNull();
  });
});
