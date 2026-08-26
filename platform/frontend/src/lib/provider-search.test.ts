import { builtInProviderLabel } from "@archestra/shared";
import { describe, expect, it } from "vitest";
import { providerSearchHaystack } from "./provider-search";

const matches = (
  provider: Parameters<typeof providerSearchHaystack>[0]["provider"],
  labels: Array<string | null | undefined>,
  query: string,
) =>
  providerSearchHaystack({ provider, labels })
    .toLowerCase()
    .includes(query.toLowerCase());

describe("providerSearchHaystack", () => {
  it("matches an entry by the products it serves, not only its label", () => {
    const labels = [builtInProviderLabel("vllm")];
    // Every one of these connects through the `vllm` entry, so each has to
    // find it — including "vLLM" itself, which is no longer the label.
    for (const query of ["llama.cpp", "LM Studio", "SGLang", "vLLM"]) {
      expect(matches("vllm", labels, query)).toBe(true);
    }
  });

  it("matches an organization's own name for a provider", () => {
    expect(
      matches(
        "vllm",
        [builtInProviderLabel("vllm"), "Northwind Inference"],
        "northwind",
      ),
    ).toBe(true);
  });

  it("does not match an unrelated provider", () => {
    expect(
      matches("anthropic", [builtInProviderLabel("anthropic")], "llama.cpp"),
    ).toBe(false);
  });
});
