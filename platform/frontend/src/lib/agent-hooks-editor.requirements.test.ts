import { describe, expect, it } from "vitest";
import { parseRequirementsInput } from "./agent-hooks-editor.requirements";

describe("parseRequirementsInput", () => {
  it("returns an empty list for empty or whitespace-only input", () => {
    expect(parseRequirementsInput("")).toEqual([]);
    expect(parseRequirementsInput("   \n  ,  ")).toEqual([]);
  });

  it("splits on commas", () => {
    expect(parseRequirementsInput("requests,httpx")).toEqual([
      "requests",
      "httpx",
    ]);
  });

  it("splits on newlines", () => {
    expect(parseRequirementsInput("requests\nhttpx")).toEqual([
      "requests",
      "httpx",
    ]);
  });

  it("splits on a mix of commas and newlines", () => {
    expect(parseRequirementsInput("requests, httpx\npydantic")).toEqual([
      "requests",
      "httpx",
      "pydantic",
    ]);
  });

  it("trims whitespace around each entry", () => {
    expect(parseRequirementsInput("  requests  ,  httpx  ")).toEqual([
      "requests",
      "httpx",
    ]);
  });

  it("drops empty entries from trailing or repeated separators", () => {
    expect(parseRequirementsInput("requests,,\n,httpx,")).toEqual([
      "requests",
      "httpx",
    ]);
  });

  it("preserves version specifiers", () => {
    expect(parseRequirementsInput("requests==2.31.0, httpx>=0.27")).toEqual([
      "requests==2.31.0",
      "httpx>=0.27",
    ]);
  });
});
