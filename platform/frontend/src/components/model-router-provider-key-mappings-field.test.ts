import { describe, expect, test } from "vitest";
import {
  modelRouterProviderApiKeyArrayToMap,
  modelRouterProviderApiKeyMapToArray,
} from "./model-router-provider-key-mappings-field";

describe("model router provider key mapping helpers", () => {
  test("converts between array and map shapes", () => {
    const array = [
      { provider: "openai" as const, chatApiKeyId: "openai-key" },
      { provider: "anthropic" as const, chatApiKeyId: "anthropic-key" },
    ];

    const map = modelRouterProviderApiKeyArrayToMap(array);

    expect(map).toEqual({
      openai: "openai-key",
      anthropic: "anthropic-key",
    });
    expect(modelRouterProviderApiKeyMapToArray(map)).toEqual(
      expect.arrayContaining(array),
    );
  });

  test("omits empty mappings from array output", () => {
    expect(
      modelRouterProviderApiKeyMapToArray({
        openai: "openai-key",
        anthropic: "",
      }),
    ).toEqual([{ provider: "openai", chatApiKeyId: "openai-key" }]);
  });
});
