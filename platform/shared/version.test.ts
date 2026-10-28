import { describe, expect, it } from "vitest";
import { normalizeVersion } from "./version";

describe("normalizeVersion", () => {
  it.each([
    ["1.4.1", "v1.4.1"],
    ["v1.4.1", "v1.4.1"],
    ["vv1.4.1", "v1.4.1"],
    ["platform-v1.4.1", "v1.4.1"],
    ["platform-1.4.1", "v1.4.1"],
    ["platform-v1.5.0-rc.4+build.12", "v1.5.0-rc.4+build.12"],
    ["0.0.0", "v0.0.0"],
    ["1.4.1-0.01a+001", "v1.4.1-0.01a+001"],
    ["01.4.1", "01.4.1"],
    ["v1.04.1", "v1.04.1"],
    ["platform-v1.4.01", "platform-v1.4.01"],
    ["1.4.1-01", "1.4.1-01"],
    ["1.4.1-", "1.4.1-"],
    ["1.4.1-rc..1", "1.4.1-rc..1"],
    ["1.4.1+", "1.4.1+"],
    ["1.4.1+build..1", "1.4.1+build..1"],
    ["1.4.1-preview/branch", "1.4.1-preview/branch"],
    ["1.4.1\n", "1.4.1\n"],
    [
      "f12beffe7b60b380558b47c052fa7a00533cd312",
      "f12beffe7b60b380558b47c052fa7a00533cd312",
    ],
    ["f12beff", "f12beff"],
    ["1234567", "1234567"],
    ["dev", "dev"],
    ["version-preview", "version-preview"],
    ["", ""],
  ])("normalizes %j to %j without changing build identifiers", (input, expected) => {
    expect(normalizeVersion(input)).toBe(expected);
    expect(normalizeVersion(normalizeVersion(input))).toBe(expected);
  });
});
