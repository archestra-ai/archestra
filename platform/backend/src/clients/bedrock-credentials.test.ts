import { afterEach, describe, expect, it, vi } from "vitest";

describe("bedrock-credentials", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  describe("isBedrockIamAuthEnabled", () => {
    it("returns false when not configured", async () => {
      vi.doMock("@/config", () => ({
        default: { llm: { bedrock: { iamAuthEnabled: false } } },
      }));
      const { isBedrockIamAuthEnabled } = await import("./bedrock-credentials");
      expect(isBedrockIamAuthEnabled()).toBe(false);
    });

    it("returns true when configured", async () => {
      vi.doMock("@/config", () => ({
        default: { llm: { bedrock: { iamAuthEnabled: true } } },
      }));
      const { isBedrockIamAuthEnabled } = await import("./bedrock-credentials");
      expect(isBedrockIamAuthEnabled()).toBe(true);
    });
  });

  describe("getBedrockRegion", () => {
    it("returns explicit region from config when set", async () => {
      vi.doMock("@/config", () => ({
        default: {
          llm: {
            bedrock: { region: "eu-west-1", baseUrl: "" },
          },
        },
      }));
      const { getBedrockRegion } = await import("./bedrock-credentials");
      expect(getBedrockRegion()).toBe("eu-west-1");
    });

    it("extracts region from provided baseUrl", async () => {
      vi.doMock("@/config", () => ({
        default: {
          llm: {
            bedrock: {
              region: "",
              baseUrl: "https://bedrock-runtime.ap-northeast-1.amazonaws.com",
            },
          },
        },
      }));
      const { getBedrockRegion } = await import("./bedrock-credentials");
      expect(
        getBedrockRegion("https://bedrock-runtime.us-west-2.amazonaws.com"),
      ).toBe("us-west-2");
    });

    it("extracts region from config baseUrl when no arg provided", async () => {
      vi.doMock("@/config", () => ({
        default: {
          llm: {
            bedrock: {
              region: "",
              baseUrl: "https://bedrock-runtime.ap-northeast-1.amazonaws.com",
            },
          },
        },
      }));
      const { getBedrockRegion } = await import("./bedrock-credentials");
      expect(getBedrockRegion()).toBe("ap-northeast-1");
    });

    it("falls back to us-east-1 when no region can be determined", async () => {
      vi.doMock("@/config", () => ({
        default: {
          llm: { bedrock: { region: "", baseUrl: "" } },
        },
      }));
      const { getBedrockRegion } = await import("./bedrock-credentials");
      expect(getBedrockRegion()).toBe("us-east-1");
    });
  });
});
