import { describe, expect, it } from "vitest";
import type { Interaction } from "./common";
import GeminiGenerateContentInteraction from "./gemini";

describe("GeminiGenerateContentInteraction", () => {
  describe("getLastUserMessage", () => {
    it("returns text from the last user message", () => {
      const interaction = {
        request: {
          contents: [
            {
              role: "user",
              parts: [{ text: "Hello Gemini" }],
            },
          ],
        },
        response: { modelVersion: "gemini-2.5-pro" },
      } as unknown as Interaction;

      const gemini = new GeminiGenerateContentInteraction(interaction);
      expect(gemini.getLastUserMessage()).toBe("Hello Gemini");
    });

    it("returns empty string when contents is undefined", () => {
      const interaction = {
        request: {},
        response: { modelVersion: "gemini-2.5-pro" },
      } as unknown as Interaction;

      const gemini = new GeminiGenerateContentInteraction(interaction);
      expect(gemini.getLastUserMessage()).toBe("");
    });

    it("returns descriptive text for image-only message", () => {
      const interaction = {
        request: {
          contents: [
            {
              role: "user",
              parts: [
                { inlineData: { mimeType: "image/png", data: "base64..." } },
              ],
            },
          ],
        },
        response: { modelVersion: "gemini-2.5-pro" },
      } as unknown as Interaction;

      const gemini = new GeminiGenerateContentInteraction(interaction);
      expect(gemini.getLastUserMessage()).toBe("[image/png data]");
    });

    it("returns descriptive text for file-only message", () => {
      const interaction = {
        request: {
          contents: [
            {
              role: "user",
              parts: [
                {
                  fileData: {
                    fileUri: "https://example.com/document.pdf",
                    mimeType: "application/pdf",
                  },
                },
              ],
            },
          ],
        },
        response: { modelVersion: "gemini-2.5-pro" },
      } as unknown as Interaction;

      const gemini = new GeminiGenerateContentInteraction(interaction);
      expect(gemini.getLastUserMessage()).toBe("[File: document.pdf]");
    });

    it("returns descriptive text for function call message", () => {
      const interaction = {
        request: {
          contents: [
            {
              role: "user",
              parts: [
                { functionCall: { name: "search", args: { query: "test" } } },
              ],
            },
          ],
        },
        response: { modelVersion: "gemini-2.5-pro" },
      } as unknown as Interaction;

      const gemini = new GeminiGenerateContentInteraction(interaction);
      expect(gemini.getLastUserMessage()).toBe("[Function call: search]");
    });

    it("returns descriptive text for function response message", () => {
      const interaction = {
        request: {
          contents: [
            {
              role: "user",
              parts: [
                {
                  functionResponse: {
                    name: "search",
                    response: { result: "ok" },
                  },
                },
              ],
            },
          ],
        },
        response: { modelVersion: "gemini-2.5-pro" },
      } as unknown as Interaction;

      const gemini = new GeminiGenerateContentInteraction(interaction);
      expect(gemini.getLastUserMessage()).toBe("[Function response: search]");
    });

    it("prefers text over non-text content when both exist", () => {
      const interaction = {
        request: {
          contents: [
            {
              role: "user",
              parts: [
                { inlineData: { mimeType: "image/png", data: "base64..." } },
                { text: "Describe this image" },
              ],
            },
          ],
        },
        response: { modelVersion: "gemini-2.5-pro" },
      } as unknown as Interaction;

      const gemini = new GeminiGenerateContentInteraction(interaction);
      expect(gemini.getLastUserMessage()).toBe("Describe this image");
    });

    it("returns last user message when multiple messages exist", () => {
      const interaction = {
        request: {
          contents: [
            {
              role: "user",
              parts: [{ text: "First message" }],
            },
            {
              role: "model",
              parts: [{ text: "Model response" }],
            },
            {
              role: "user",
              parts: [{ text: "Second message" }],
            },
          ],
        },
        response: { modelVersion: "gemini-2.5-pro" },
      } as unknown as Interaction;

      const gemini = new GeminiGenerateContentInteraction(interaction);
      expect(gemini.getLastUserMessage()).toBe("Second message");
    });
  });
});
