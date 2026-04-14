import { describe, expect, test } from "vitest";
import {
  isLoopbackAddress,
  isLoopbackRedirectUri,
  isPrivateOrLoopbackHostname,
  loopbackRedirectUriMatchesIgnoringPort,
} from "./network";

describe("isLoopbackAddress", () => {
  // IPv4 loopback range (127.0.0.0/8)
  test("returns true for 127.0.0.1", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
  });

  test("returns true for other 127.x.x.x addresses", () => {
    expect(isLoopbackAddress("127.0.0.2")).toBe(true);
    expect(isLoopbackAddress("127.1.2.3")).toBe(true);
    expect(isLoopbackAddress("127.255.255.255")).toBe(true);
  });

  // IPv6 loopback
  test("returns true for ::1", () => {
    expect(isLoopbackAddress("::1")).toBe(true);
  });

  // IPv4-mapped IPv6 loopback
  test("returns true for ::ffff:127.0.0.1", () => {
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
  });

  test("returns true for ::ffff:127.1.2.3", () => {
    expect(isLoopbackAddress("::ffff:127.1.2.3")).toBe(true);
  });

  // Non-loopback addresses
  test("returns false for public IPv4", () => {
    expect(isLoopbackAddress("1.2.3.4")).toBe(false);
    expect(isLoopbackAddress("192.168.1.1")).toBe(false);
    expect(isLoopbackAddress("10.0.0.5")).toBe(false);
  });

  test("returns false for non-loopback IPv6", () => {
    expect(isLoopbackAddress("::2")).toBe(false);
    expect(isLoopbackAddress("fe80::1")).toBe(false);
  });

  test("returns false for non-loopback IPv4-mapped IPv6", () => {
    expect(isLoopbackAddress("::ffff:192.168.1.1")).toBe(false);
    expect(isLoopbackAddress("::ffff:10.0.0.1")).toBe(false);
  });

  test("returns false for empty string", () => {
    expect(isLoopbackAddress("")).toBe(false);
  });

  test("returns false for invalid input", () => {
    expect(isLoopbackAddress("not-an-ip")).toBe(false);
    expect(isLoopbackAddress("127.0.0")).toBe(false);
  });
});

describe("isLoopbackRedirectUri", () => {
  test("returns true for 127.0.0.1", () => {
    expect(isLoopbackRedirectUri("http://127.0.0.1:8005/callback")).toBe(true);
  });

  test("returns true for localhost", () => {
    expect(isLoopbackRedirectUri("http://localhost:3000/callback")).toBe(true);
  });

  test("returns true for IPv6 loopback", () => {
    expect(isLoopbackRedirectUri("http://[::1]:9000/callback")).toBe(true);
  });

  test("returns true for 127.0.0.1 without port", () => {
    expect(isLoopbackRedirectUri("http://127.0.0.1/callback")).toBe(true);
  });

  test("returns false for non-loopback hostname", () => {
    expect(isLoopbackRedirectUri("https://example.com/callback")).toBe(false);
  });

  test("returns false for private IP", () => {
    expect(isLoopbackRedirectUri("http://192.168.1.1/callback")).toBe(false);
  });

  test("returns false for invalid URI", () => {
    expect(isLoopbackRedirectUri("not-a-uri")).toBe(false);
  });

  test("returns false for empty string", () => {
    expect(isLoopbackRedirectUri("")).toBe(false);
  });
});

describe("loopbackRedirectUriMatchesIgnoringPort", () => {
  test("matches same scheme+host+path with different port", () => {
    expect(
      loopbackRedirectUriMatchesIgnoringPort(
        "http://127.0.0.1:54321/callback",
        ["http://127.0.0.1:3000/callback"],
      ),
    ).toBe(true);
  });

  test("matches localhost with different port", () => {
    expect(
      loopbackRedirectUriMatchesIgnoringPort(
        "http://localhost:54321/callback",
        ["http://localhost:3000/callback"],
      ),
    ).toBe(true);
  });

  test("matches when requested has port and registered has no port", () => {
    expect(
      loopbackRedirectUriMatchesIgnoringPort(
        "http://127.0.0.1:54321/callback",
        ["http://127.0.0.1/callback"],
      ),
    ).toBe(true);
  });

  test("does not match different paths", () => {
    expect(
      loopbackRedirectUriMatchesIgnoringPort("http://127.0.0.1:54321/other", [
        "http://127.0.0.1:3000/callback",
      ]),
    ).toBe(false);
  });

  test("does not match different schemes", () => {
    expect(
      loopbackRedirectUriMatchesIgnoringPort(
        "https://127.0.0.1:54321/callback",
        ["http://127.0.0.1:3000/callback"],
      ),
    ).toBe(false);
  });

  test("does not match localhost vs 127.0.0.1", () => {
    expect(
      loopbackRedirectUriMatchesIgnoringPort(
        "http://localhost:54321/callback",
        ["http://127.0.0.1:3000/callback"],
      ),
    ).toBe(false);
  });

  test("does not match non-loopback URI", () => {
    expect(
      loopbackRedirectUriMatchesIgnoringPort(
        "https://example.com:8080/callback",
        ["https://example.com:3000/callback"],
      ),
    ).toBe(false);
  });

  test("returns false for empty registered URIs", () => {
    expect(
      loopbackRedirectUriMatchesIgnoringPort(
        "http://127.0.0.1:54321/callback",
        [],
      ),
    ).toBe(false);
  });

  test("matches against multiple registered URIs", () => {
    expect(
      loopbackRedirectUriMatchesIgnoringPort(
        "http://127.0.0.1:54321/callback",
        ["https://example.com/callback", "http://127.0.0.1:3000/callback"],
      ),
    ).toBe(true);
  });

  test("returns false for invalid requested URI", () => {
    expect(
      loopbackRedirectUriMatchesIgnoringPort("not-a-url", [
        "http://127.0.0.1:3000/callback",
      ]),
    ).toBe(false);
  });
});

describe("isPrivateOrLoopbackHostname", () => {
  test("returns true for localhost hostnames", () => {
    expect(isPrivateOrLoopbackHostname("localhost")).toBe(true);
    expect(isPrivateOrLoopbackHostname("idp.localhost")).toBe(true);
  });

  test("returns true for loopback and private IPv4 addresses", () => {
    expect(isPrivateOrLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isPrivateOrLoopbackHostname("10.0.0.1")).toBe(true);
    expect(isPrivateOrLoopbackHostname("172.16.0.10")).toBe(true);
    expect(isPrivateOrLoopbackHostname("192.168.1.20")).toBe(true);
    expect(isPrivateOrLoopbackHostname("169.254.10.5")).toBe(true);
  });

  test("returns true for loopback and private IPv6 addresses", () => {
    expect(isPrivateOrLoopbackHostname("::1")).toBe(true);
    expect(isPrivateOrLoopbackHostname("::")).toBe(true);
    expect(isPrivateOrLoopbackHostname("fc00::1")).toBe(true);
    expect(isPrivateOrLoopbackHostname("fd12::1")).toBe(true);
    expect(isPrivateOrLoopbackHostname("fe80::1")).toBe(true);
    expect(isPrivateOrLoopbackHostname("::ffff:10.0.0.1")).toBe(true);
  });

  test("returns false for public hostnames and IP addresses", () => {
    expect(isPrivateOrLoopbackHostname("example.com")).toBe(false);
    expect(isPrivateOrLoopbackHostname("idp.example.net")).toBe(false);
    expect(isPrivateOrLoopbackHostname("8.8.8.8")).toBe(false);
    expect(isPrivateOrLoopbackHostname("2001:4860:4860::8888")).toBe(false);
  });

  test("returns false for invalid hostname input", () => {
    expect(isPrivateOrLoopbackHostname("")).toBe(false);
    expect(isPrivateOrLoopbackHostname("not a host")).toBe(false);
  });
});
