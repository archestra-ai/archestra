import { describe, expect, test } from "vitest";
import {
  providerApiKeyArrayToMap,
  providerApiKeyMapToArray,
} from "./provider-key-mappings-field";

describe("provider key mapping helpers", () => {
  test("converts between array and map shapes", () => {
    const array = [
      { provider: "openai" as const, providerApiKeyId: "openai-key" },
      { provider: "anthropic" as const, providerApiKeyId: "anthropic-key" },
    ];

    const map = providerApiKeyArrayToMap(array);

    expect(map).toEqual({
      openai: "openai-key",
      anthropic: "anthropic-key",
    });
    expect(providerApiKeyMapToArray(map)).toEqual(
      expect.arrayContaining(array),
    );
  });

  test("omits empty mappings from array output", () => {
    expect(
      providerApiKeyMapToArray({
        openai: "openai-key",
        anthropic: "",
      }),
    ).toEqual([{ provider: "openai", providerApiKeyId: "openai-key" }]);
  });
});
