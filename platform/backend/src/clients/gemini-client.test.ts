import {
  isVertexModelReachable,
  resolveVertexLocation,
} from "@/clients/gemini-client";
import config from "@/config";
import { beforeEach, describe, expect, test } from "@/test";

/**
 * A single Vertex location cannot serve the whole Gemini catalog — the 3.x
 * generations are global-only, while Gemma MaaS and `gemini-embedding-001` are
 * regional-only — so these two functions decide where each model is addressed
 * and whether it can be offered at all.
 */
describe("Vertex AI location resolution", () => {
  beforeEach(() => {
    // The shared setup restores the pristine config after every test.
    config.llm.gemini.vertexAi.location = "us-central1";
    config.llm.gemini.vertexAi.allowGlobalEndpoint = false;
  });

  describe("with a pinned region and the global endpoint disallowed", () => {
    test("keeps every model on the configured region", () => {
      expect(resolveVertexLocation("gemini-2.5-pro")).toBe("us-central1");
      // Routing a global-only model to the region would 404, but sending it to
      // `global` unasked would move traffic out of the pinned region; the model
      // is dropped from the catalog instead.
      expect(resolveVertexLocation("gemini-3.5-flash")).toBe("us-central1");
    });

    test("reports global-only models as unreachable", () => {
      expect(isVertexModelReachable("gemini-3.5-flash")).toBe(false);
      expect(isVertexModelReachable("gemini-embedding-2")).toBe(false);
      expect(isVertexModelReachable("gemini-2.5-pro")).toBe(true);
      expect(isVertexModelReachable("gemini-embedding-001")).toBe(true);
      expect(isVertexModelReachable("gemma-4-26b-a4b-it-maas")).toBe(true);
    });
  });

  describe("with a pinned region and the global endpoint allowed", () => {
    beforeEach(() => {
      config.llm.gemini.vertexAi.allowGlobalEndpoint = true;
    });

    test("sends only global-only models to the global endpoint", () => {
      expect(resolveVertexLocation("gemini-3.5-flash")).toBe("global");
      expect(resolveVertexLocation("gemini-embedding-2")).toBe("global");
      // Everything the region can serve stays in the region, so enabling the
      // fallback does not relocate traffic that had no need to move.
      expect(resolveVertexLocation("gemini-2.5-pro")).toBe("us-central1");
      expect(resolveVertexLocation("gemini-embedding-001")).toBe("us-central1");
      expect(resolveVertexLocation("gemma-4-26b-a4b-it-maas")).toBe(
        "us-central1",
      );
    });

    test("reports every model as reachable", () => {
      expect(isVertexModelReachable("gemini-3.5-flash")).toBe(true);
      expect(isVertexModelReachable("gemini-2.5-pro")).toBe(true);
    });
  });

  describe("with the configured location already global", () => {
    beforeEach(() => {
      config.llm.gemini.vertexAi.location = "global";
    });

    test("addresses everything globally without needing the opt-in", () => {
      expect(resolveVertexLocation("gemini-3.5-flash")).toBe("global");
      expect(resolveVertexLocation("gemini-2.5-pro")).toBe("global");
      expect(isVertexModelReachable("gemini-3.5-flash")).toBe(true);
    });
  });

  test("falls back to the configured location when no model is given", () => {
    // Catalog-listing calls are not about one model.
    expect(resolveVertexLocation()).toBe("us-central1");
    expect(resolveVertexLocation(null)).toBe("us-central1");

    config.llm.gemini.vertexAi.allowGlobalEndpoint = true;
    expect(resolveVertexLocation()).toBe("us-central1");
  });
});
