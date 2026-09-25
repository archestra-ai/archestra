import { describe, expect, test } from "vitest";
import {
  parsePublicHostSchemes,
  resolvePublicScheme,
  servesHttps,
} from "./public-origin";

describe("parsePublicHostSchemes", () => {
  test("records the scheme each host was configured under", () => {
    const schemes = parsePublicHostSchemes([
      "https://app.example.com",
      "http://internal.example.com:9000",
    ]);

    expect(schemes.get("app.example.com")).toBe("https");
    expect(schemes.get("internal.example.com:9000")).toBe("http");
  });

  test("splits a comma-separated entry", () => {
    const schemes = parsePublicHostSchemes([
      "http://archestra.default.svc:9000, https://api.example.com",
    ]);

    expect(schemes.get("archestra.default.svc:9000")).toBe("http");
    expect(schemes.get("api.example.com")).toBe("https");
  });

  test("lets https win when a host is configured under both schemes", () => {
    expect(
      parsePublicHostSchemes([
        "http://app.example.com",
        "https://app.example.com",
      ]).get("app.example.com"),
    ).toBe("https");
    expect(
      parsePublicHostSchemes([
        "https://app.example.com",
        "http://app.example.com",
      ]).get("app.example.com"),
    ).toBe("https");
  });

  test("lowercases the host so a mixed-case Host header still matches", () => {
    expect(
      parsePublicHostSchemes(["https://App.Example.COM"]).has(
        "app.example.com",
      ),
    ).toBe(true);
  });

  test("ignores blank, missing, and malformed entries", () => {
    const schemes = parsePublicHostSchemes([
      undefined,
      null,
      "",
      "   ",
      "not a url",
      ",,",
      "https://app.example.com",
    ]);

    expect([...schemes.keys()]).toEqual(["app.example.com"]);
  });
});

describe("resolvePublicScheme", () => {
  const schemes = parsePublicHostSchemes([
    "https://app.example.com",
    "http://plain.example.com",
  ]);

  test("upgrades an observed http scheme for a configured https host", () => {
    expect(
      resolvePublicScheme({
        host: "app.example.com",
        observedScheme: "http",
        schemes,
      }),
    ).toBe("https");
  });

  test("keeps http for a host configured over http", () => {
    expect(
      resolvePublicScheme({
        host: "plain.example.com",
        observedScheme: "http",
        schemes,
      }),
    ).toBe("http");
  });

  test("keeps http for a host in no configured public URL", () => {
    expect(
      resolvePublicScheme({
        host: "unknown.example.com",
        observedScheme: "http",
        schemes,
      }),
    ).toBe("http");
  });

  test("never downgrades an observed https scheme", () => {
    expect(
      resolvePublicScheme({
        host: "plain.example.com",
        observedScheme: "https",
        schemes,
      }),
    ).toBe("https");
  });
});

describe("servesHttps", () => {
  test("is true when any configured public URL uses https", () => {
    expect(
      servesHttps(
        parsePublicHostSchemes([
          "http://internal:9000",
          "https://app.example.com",
        ]),
      ),
    ).toBe(true);
  });

  test("is false for an all-http configuration", () => {
    expect(servesHttps(parsePublicHostSchemes(["http://localhost:3000"]))).toBe(
      false,
    );
  });
});
