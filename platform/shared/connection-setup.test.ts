import { describe, expect, it } from "vitest";
import { defaultConnectionModel } from "./connection-setup";

describe("connection model defaults", () => {
  it.each([
    [["gpt-5.5", "gpt-6-sol", "gpt-6.1-sol"], "gpt-6.1-sol"],
    [
      ["openai:gpt-5.6-sol", "openai:gpt-6-sol", "openai:gpt-6.1-sol"],
      "openai:gpt-6.1-sol",
    ],
    [["gpt-5.5", "gpt-6-luna"], "gpt-6-luna"],
    [["gpt-5.5", "openai/gpt-6.1-sol"], "openai/gpt-6.1-sol"],
    [["o4-mini", "gpt-5.5"], "gpt-5.5"],
    [["o4-mini"], "o4-mini"],
    [["gpt-60", "gpt-6.1-sol"], "gpt-6.1-sol"],
    [[], null],
  ])("selects only an available model from %j", (modelIds, expected) => {
    expect(defaultConnectionModel({ provider: "openai", modelIds })).toBe(
      expected,
    );
  });

  it("does not apply OpenAI family preferences to another provider", () => {
    expect(
      defaultConnectionModel({
        provider: "ollama",
        modelIds: ["local-model", "gpt-6.1-sol"],
      }),
    ).toBe("local-model");
  });
});
