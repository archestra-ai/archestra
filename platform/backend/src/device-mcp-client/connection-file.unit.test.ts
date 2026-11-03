import { describe, expect, test } from "vitest";
import { parseDeviceConnectionFile } from "./connection-file";

const code = "a".repeat(43);
const file = (url: string, extras = {}) =>
  JSON.stringify({ version: 1, url, code, ...extras });

describe("desktop connection file", () => {
  test("accepts deployment origins and normalizes a trailing slash", () => {
    expect(
      parseDeviceConnectionFile(file("https://deployment.example/")),
    ).toEqual({ version: 1, url: "https://deployment.example", code });
    expect(parseDeviceConnectionFile(file("http://localhost:13500")).url).toBe(
      "http://localhost:13500",
    );
  });

  test.each([
    "http://deployment.example",
    "https://user:password@deployment.example",
    "https://deployment.example/path",
    "https://deployment.example?code=secret",
    "https://deployment.example/#fragment",
    "file:///etc/passwd",
    "javascript:alert(1)",
  ])("refuses unsafe or ambiguous deployment URLs: %s", (url) => {
    expect(() => parseDeviceConnectionFile(file(url))).toThrow();
  });

  test("separates local device enrollment from legacy MCP setup and refuses mixed purposes", () => {
    expect(
      parseDeviceConnectionFile(
        file("https://deployment.example", {
          version: 2,
          purpose: "local-device",
        }),
      ),
    ).toEqual({
      version: 2,
      purpose: "local-device",
      url: "https://deployment.example",
      code,
    });
    expect(() =>
      parseDeviceConnectionFile(
        file("https://deployment.example", { version: 2 }),
      ),
    ).toThrow();
    expect(() =>
      parseDeviceConnectionFile(
        file("https://deployment.example", { version: 2, purpose: "execute" }),
      ),
    ).toThrow();
    expect(() =>
      parseDeviceConnectionFile(
        file("https://deployment.example", { purpose: "local-device" }),
      ),
    ).toThrow();
  });

  test("refuses executable payloads, malformed codes, and oversized files", () => {
    expect(() =>
      parseDeviceConnectionFile(
        file("https://deployment.example", { command: "shell" }),
      ),
    ).toThrow();
    expect(() =>
      parseDeviceConnectionFile(
        file("https://deployment.example", { code: "short" }),
      ),
    ).toThrow();
    expect(() =>
      parseDeviceConnectionFile(
        file("https://deployment.example") + " ".repeat(4096),
      ),
    ).toThrow();
    expect(() => parseDeviceConnectionFile("{}")).toThrow();
  });
});
