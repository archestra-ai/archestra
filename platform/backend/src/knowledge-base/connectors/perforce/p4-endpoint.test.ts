// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import { describe, expect, test } from "@/test";
import {
  deriveP4WireAddress,
  p4PortCandidates,
  p4ServerScope,
} from "./p4-endpoint";

describe("deriveP4WireAddress", () => {
  test("derives the p4d host from the REST server URL at the default wire port", () => {
    expect(
      deriveP4WireAddress({ serverUrl: "https://perforce.example.com:8080" }),
    ).toEqual({ host: "perforce.example.com", port: 1666 });
  });

  test("ignores the REST port, which belongs to the web server, not p4d", () => {
    expect(
      deriveP4WireAddress({ serverUrl: "http://p4.internal:9999/api/v0" })
        ?.port,
    ).toBe(1666);
  });

  test("an explicit override wins over the derivation", () => {
    expect(
      deriveP4WireAddress({
        serverUrl: "https://rest.example.com:8080",
        p4Port: "ssl:p4d.example.com:2666",
      }),
    ).toEqual({ host: "p4d.example.com", port: 2666 });
  });

  test("IPv6 hosts are unbracketed so they resolve as written", () => {
    expect(
      deriveP4WireAddress({ serverUrl: "http://[2001:db8::5]:8080" })?.host,
    ).toBe("2001:db8::5");
  });

  test("returns null when neither source yields an address", () => {
    expect(deriveP4WireAddress({ serverUrl: "not a url" })).toBeNull();
    expect(
      deriveP4WireAddress({
        serverUrl: "https://p4.example.com",
        p4Port: "missing-port",
      }),
    ).toBeNull();
  });
});

describe("p4PortCandidates", () => {
  test("offers both transports for the one wire address, HTTPS hinting SSL first", () => {
    expect(
      p4PortCandidates({ serverUrl: "https://p4.example.com:8080" }),
    ).toEqual(["ssl:p4.example.com:1666", "p4.example.com:1666"]);
  });

  test("a plain REST URL hints at a plain wire transport first", () => {
    expect(
      p4PortCandidates({ serverUrl: "http://p4.example.com:8080" }),
    ).toEqual(["p4.example.com:1666", "ssl:p4.example.com:1666"]);
  });

  test("an override's prefix only orders the probe — the other transport still gets tried", () => {
    expect(
      p4PortCandidates({
        serverUrl: "http://rest.example.com",
        p4Port: "ssl:p4d.example.com:1666",
      }),
    ).toEqual(["ssl:p4d.example.com:1666", "p4d.example.com:1666"]);
  });

  test("IPv6 candidates are bracketed the way p4 expects", () => {
    expect(
      p4PortCandidates({ serverUrl: "http://[2001:db8::5]:8080" })[0],
    ).toBe("[2001:db8::5]:1666");
  });
});

describe("p4ServerScope", () => {
  test("is transport-independent, so a plain/SSL flip never re-identifies groups", () => {
    const viaSsl = deriveP4WireAddress({
      serverUrl: "https://P4.Example.com:8080",
      p4Port: "ssl:P4.Example.com:1666",
    });
    const viaPlain = deriveP4WireAddress({
      serverUrl: "https://P4.Example.com:8080",
      p4Port: "P4.Example.com:1666",
    });
    expect(p4ServerScope(viaSsl!)).toBe(p4ServerScope(viaPlain!));
    expect(p4ServerScope(viaPlain!)).toBe("p4.example.com:1666");
  });

  test("distinguishes two Perforce servers", () => {
    expect(p4ServerScope({ host: "a.example.com", port: 1666 })).not.toBe(
      p4ServerScope({ host: "b.example.com", port: 1666 }),
    );
  });
});
