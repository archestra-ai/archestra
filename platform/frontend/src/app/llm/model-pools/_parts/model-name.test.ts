import { describe, expect, test } from "vitest";
import { isPoolableModel, poolModelName, suggestModelId } from "./model-name";

describe("poolModelName", () => {
  test("drops Bedrock's region, vendor and version", () => {
    expect(poolModelName("bedrock", "zai.glm-5.3")).toBe("glm-5.3");
    expect(poolModelName("bedrock", "us.zai.glm-5.3")).toBe("glm-5.3");
    expect(poolModelName("bedrock", "global.zai.glm-5.3")).toBe("glm-5.3");
    expect(
      poolModelName("bedrock", "anthropic.claude-sonnet-4-5-20250929-v1:0"),
    ).toBe("claude-sonnet-4-5-20250929");
  });

  test("drops OpenRouter's vendor path", () => {
    expect(poolModelName("openrouter", "z-ai/glm-4.6")).toBe("glm-4.6");
  });

  test("keeps other providers' ids", () => {
    expect(poolModelName("zhipuai", "glm-4.6")).toBe("glm-4.6");
    expect(poolModelName("openai", "gpt-4.1-mini")).toBe("gpt-4.1-mini");
  });
});

describe("suggestModelId", () => {
  test("prefers the exact id, then the shortest id with that name", () => {
    expect(suggestModelId("glm-5", "zhipuai", ["glm-5"])).toBe("glm-5");
    expect(
      suggestModelId("glm-5.3", "bedrock", [
        "global.zai.glm-5.3",
        "us.zai.glm-5.3",
        "zai.glm-4.7",
      ]),
    ).toBe("us.zai.glm-5.3");
    expect(suggestModelId("glm-5.3-flash", "bedrock", ["zai.glm-5.3"])).toBe(
      "glm-5.3-flash",
    );
  });
});

describe("isPoolableModel", () => {
  test("leaves out embedding and ignored models", () => {
    const model = { embeddingDimensions: null, ignored: false };
    expect(isPoolableModel({ ...model, modelId: "glm-5" })).toBe(true);
    expect(
      isPoolableModel({ ...model, modelId: "text-embedding-3-small" }),
    ).toBe(false);
    expect(
      isPoolableModel({
        ...model,
        modelId: "amazon.titan-embed-text-v2:0",
        embeddingDimensions: 1024,
      }),
    ).toBe(false);
    expect(isPoolableModel({ ...model, modelId: "glm-4", ignored: true })).toBe(
      false,
    );
  });
});
