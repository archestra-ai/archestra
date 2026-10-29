import { describe, expect, it } from "vitest";
import config from "@/config";
import {
  getBedrockBaseUrl,
  getBedrockRegion,
  isBedrockIamAuthEnabled,
} from "./bedrock-credentials";

function setBedrockConfig(bedrock: {
  iamAuthEnabled?: boolean;
  region?: string;
  baseUrl?: string;
}) {
  Object.assign(config.llm.bedrock, bedrock);
}

describe("bedrock-credentials", () => {
  describe("isBedrockIamAuthEnabled", () => {
    it("returns false when not configured", () => {
      setBedrockConfig({ iamAuthEnabled: false });
      expect(isBedrockIamAuthEnabled()).toBe(false);
    });

    it("returns true when configured", () => {
      setBedrockConfig({ iamAuthEnabled: true });
      expect(isBedrockIamAuthEnabled()).toBe(true);
    });
  });

  describe("getBedrockRegion", () => {
    it("returns explicit region from config when set", () => {
      setBedrockConfig({ region: "eu-west-1", baseUrl: "" });
      expect(getBedrockRegion()).toBe("eu-west-1");
    });

    it("extracts region from provided baseUrl", () => {
      setBedrockConfig({
        region: "",
        baseUrl: "https://bedrock-runtime.ap-northeast-1.amazonaws.com",
      });
      expect(
        getBedrockRegion("https://bedrock-runtime.us-west-2.amazonaws.com"),
      ).toBe("us-west-2");
    });

    it("extracts region from config baseUrl when no arg provided", () => {
      setBedrockConfig({
        region: "",
        baseUrl: "https://bedrock-runtime.ap-northeast-1.amazonaws.com",
      });
      expect(getBedrockRegion()).toBe("ap-northeast-1");
    });

    it("falls back to us-east-1 when no region can be determined", () => {
      setBedrockConfig({ region: "", baseUrl: "" });
      expect(getBedrockRegion()).toBe("us-east-1");
    });
  });

  describe("getBedrockBaseUrl", () => {
    it("uses a per-key custom endpoint", () => {
      setBedrockConfig({ region: "eu-west-1", baseUrl: "" });
      expect(getBedrockBaseUrl("https://bedrock.internal.example/v1")).toBe(
        "https://bedrock.internal.example/v1",
      );
    });

    it("derives the runtime endpoint from the configured region", () => {
      setBedrockConfig({ region: "eu-west-1", baseUrl: "" });
      expect(getBedrockBaseUrl()).toBe(
        "https://bedrock-runtime.eu-west-1.amazonaws.com",
      );
    });

    it("derives the default us-east-1 endpoint when no override exists", () => {
      setBedrockConfig({ region: "", baseUrl: "" });
      expect(getBedrockBaseUrl()).toBe(
        "https://bedrock-runtime.us-east-1.amazonaws.com",
      );
    });
  });
});
