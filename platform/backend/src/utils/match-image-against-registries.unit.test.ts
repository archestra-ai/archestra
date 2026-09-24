import { describe, expect, it } from "vitest";
import { imageMatchesTrustedRegistries } from "./match-image-against-registries";

const DIGEST = `sha256:${"a".repeat(64)}`;

describe("imageMatchesTrustedRegistries", () => {
  it("matches an image under a registry/repo prefix at a path boundary", () => {
    expect(
      imageMatchesTrustedRegistries("ghcr.io/acme/foo:v1", ["ghcr.io/acme"]),
    ).toBe(true);
  });

  it("does not allow a sibling repo sharing a name prefix (boundary check)", () => {
    expect(
      imageMatchesTrustedRegistries("ghcr.io/acme-evil/x", ["ghcr.io/acme"]),
    ).toBe(false);
  });

  it("ignores the digest when matching", () => {
    expect(
      imageMatchesTrustedRegistries(`docker.io/evil/bar@${DIGEST}`, [
        "ghcr.io/acme",
      ]),
    ).toBe(false);
    expect(
      imageMatchesTrustedRegistries(`ghcr.io/acme/foo@${DIGEST}`, [
        "ghcr.io/acme",
      ]),
    ).toBe(true);
  });

  it("normalizes implicit docker.io/library official images", () => {
    expect(
      imageMatchesTrustedRegistries("redis:7", ["docker.io/library"]),
    ).toBe(true);
  });

  it("normalizes a bare entry the same way as a bare image", () => {
    expect(imageMatchesTrustedRegistries("redis", ["redis"])).toBe(true);
  });

  it("treats a slash-prefixed image without a host as docker.io", () => {
    expect(
      imageMatchesTrustedRegistries("acme/foo:1", ["docker.io/acme"]),
    ).toBe(true);
    expect(imageMatchesTrustedRegistries("acme/foo:1", ["ghcr.io/acme"])).toBe(
      false,
    );
  });

  it("supports host-only entries (any repo on the host)", () => {
    expect(
      imageMatchesTrustedRegistries("ghcr.io/anyone/thing:tag", ["ghcr.io"]),
    ).toBe(true);
    expect(imageMatchesTrustedRegistries("docker.io/x/y", ["ghcr.io"])).toBe(
      false,
    );
  });

  it("does not let a host-only entry match a look-alike host", () => {
    expect(
      imageMatchesTrustedRegistries("ghcr.io.evil.com/x/y", ["ghcr.io"]),
    ).toBe(false);
  });

  it("parses a host with a port without mistaking it for a tag", () => {
    expect(
      imageMatchesTrustedRegistries("localhost:5000/foo:bar", [
        "localhost:5000",
      ]),
    ).toBe(true);
    expect(
      imageMatchesTrustedRegistries("localhost:5000/foo:bar", [
        "localhost:5000/foo",
      ]),
    ).toBe(true);
    expect(
      imageMatchesTrustedRegistries("localhost:5000/foobar", [
        "localhost:5000/foo",
      ]),
    ).toBe(false);
  });

  it("supports a dotless host:port entry (e.g. a k8s-internal registry)", () => {
    expect(
      imageMatchesTrustedRegistries("registry:5000/team/app:1", [
        "registry:5000",
      ]),
    ).toBe(true);
    expect(
      imageMatchesTrustedRegistries("registry:5000/team/app:1", [
        "registry:5000/team",
      ]),
    ).toBe(true);
    expect(
      imageMatchesTrustedRegistries("other:5000/x", ["registry:5000"]),
    ).toBe(false);
  });

  it("strips a tag from a registry entry (approval is by repo, not tag)", () => {
    expect(
      imageMatchesTrustedRegistries("ghcr.io/acme/foo:v2", [
        "ghcr.io/acme/foo:v1",
      ]),
    ).toBe(true);
  });

  it("is case-insensitive on the registry host", () => {
    expect(
      imageMatchesTrustedRegistries("GHCR.IO/acme/foo", ["ghcr.io/acme"]),
    ).toBe(true);
  });

  it("canonicalizes Docker Hub host aliases to docker.io", () => {
    expect(
      imageMatchesTrustedRegistries("registry-1.docker.io/library/redis", [
        "docker.io/library",
      ]),
    ).toBe(true);
    expect(
      imageMatchesTrustedRegistries("index.docker.io/acme/foo", [
        "docker.io/acme",
      ]),
    ).toBe(true);
  });

  it("matches against any entry in the list", () => {
    expect(
      imageMatchesTrustedRegistries("ghcr.io/acme/foo", [
        "docker.io/library",
        "ghcr.io/acme",
      ]),
    ).toBe(true);
  });

  it("returns false for an empty or missing trusted list", () => {
    expect(imageMatchesTrustedRegistries("ghcr.io/acme/foo", [])).toBe(false);
    expect(imageMatchesTrustedRegistries("ghcr.io/acme/foo", null)).toBe(false);
    expect(imageMatchesTrustedRegistries("ghcr.io/acme/foo", undefined)).toBe(
      false,
    );
  });

  it("returns false for a blank image reference", () => {
    expect(imageMatchesTrustedRegistries("", ["ghcr.io"])).toBe(false);
    expect(imageMatchesTrustedRegistries("   ", ["ghcr.io"])).toBe(false);
  });
});
