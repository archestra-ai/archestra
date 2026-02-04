import { describe, expect, it } from "vitest";
import { hasNewerVersion } from "./version-utils";

describe("hasNewerVersion", () => {
  it("returns false when versions are the same (no prefixes)", () => {
    expect(hasNewerVersion("1.0.37", "1.0.37")).toBe(false);
  });

  it("returns false when versions are the same but latest has v prefix", () => {
    expect(hasNewerVersion("1.0.37", "v1.0.37")).toBe(false);
  });

  it("returns false when versions are the same but latest has platform- prefix", () => {
    expect(hasNewerVersion("1.0.37", "platform-1.0.37")).toBe(false);
  });

  it("returns false when versions are the same but latest has platform-v prefix", () => {
    expect(hasNewerVersion("1.0.37", "platform-v1.0.37")).toBe(false);
  });

  it("returns false when current has v prefix and latest has platform-v prefix (same version)", () => {
    expect(hasNewerVersion("v1.0.37", "platform-v1.0.37")).toBe(false);
  });

  it("returns true when latest is a newer patch version", () => {
    expect(hasNewerVersion("1.0.37", "platform-v1.0.38")).toBe(true);
  });

  it("returns true when latest is a newer minor version", () => {
    expect(hasNewerVersion("1.0.37", "platform-v1.1.0")).toBe(true);
  });

  it("returns true when latest is a newer major version", () => {
    expect(hasNewerVersion("1.0.37", "platform-v2.0.0")).toBe(true);
  });

  it("returns false when current is newer than latest", () => {
    expect(hasNewerVersion("1.0.38", "platform-v1.0.37")).toBe(false);
  });

  it("returns false when current version is a commit hash (dev build)", () => {
    expect(hasNewerVersion("abc1234", "platform-v1.0.38")).toBe(false);
  });

  it("returns false when latest tag is not semver", () => {
    expect(hasNewerVersion("1.0.37", "latest")).toBe(false);
  });

  it("returns false when both versions are non-semver", () => {
    expect(hasNewerVersion("dev-build", "nightly")).toBe(false);
  });

  it("returns false when current version is empty", () => {
    expect(hasNewerVersion("", "v1.0.38")).toBe(false);
  });

  it("returns false when latest tag is empty", () => {
    expect(hasNewerVersion("1.0.37", "")).toBe(false);
  });

  it("handles prerelease versions correctly", () => {
    expect(hasNewerVersion("1.0.37", "v1.0.38-beta.1")).toBe(true);
  });

  it("returns true for multi-digit version components", () => {
    expect(hasNewerVersion("1.0.9", "v1.0.10")).toBe(true);
  });

  it("correctly compares when string comparison would fail (1.0.9 vs 1.0.10)", () => {
    // String comparison: "1.0.9" > "1.0.10" (because "9" > "1")
    // Semver comparison: 1.0.9 < 1.0.10 (correct)
    expect(hasNewerVersion("1.0.9", "1.0.10")).toBe(true);
  });
});
