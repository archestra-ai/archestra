import { describe, expect, test } from "@/test";
import {
  __test,
  stripImagesFromMessages,
  type UiMessage,
} from "./strip-images-from-messages";

const { isBase64ImageData, stripImagesFromObject, IMAGE_STRIPPED_PLACEHOLDER } =
  __test;

describe("strip-images-from-messages", () => {
  describe("isBase64ImageData", () => {
    test("detects data URL images", () => {
      expect(isBase64ImageData("data:image/png;base64,iVBORw0KGgo...")).toBe(
        true,
      );
      expect(isBase64ImageData("data:image/jpeg;base64,/9j/4AAQ...")).toBe(
        true,
      );
    });

    test("detects raw base64 image data", () => {
      // Real base64 data is long - simulate with >1000 chars of valid base64
      const longBase64 = "A".repeat(1500);
      expect(isBase64ImageData(longBase64)).toBe(true);
    });

    test("ignores short strings", () => {
      expect(isBase64ImageData("short")).toBe(false);
      expect(isBase64ImageData("ABC123")).toBe(false);
    });

    test("ignores non-strings", () => {
      expect(isBase64ImageData(123)).toBe(false);
      expect(isBase64ImageData(null)).toBe(false);
      expect(isBase64ImageData(undefined)).toBe(false);
      expect(isBase64ImageData({ data: "test" })).toBe(false);
    });

    test("ignores regular text even if long", () => {
      // Text with spaces and special chars is not valid base64
      const longText =
        "This is a long text with spaces and punctuation! ".repeat(50);
      expect(isBase64ImageData(longText)).toBe(false);
    });
  });

  describe("stripImagesFromObject", () => {
    test("strips base64 data from 'data' key", () => {
      const input = {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: "data:image/png;base64,iVBORw0KGgo...",
        },
      };

      const result = stripImagesFromObject(input);

      expect(result).toEqual({
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: IMAGE_STRIPPED_PLACEHOLDER,
        },
      });
    });

    test("strips base64 data from 'image_data' key", () => {
      const longBase64 = "A".repeat(1500);
      const input = {
        image_data: longBase64,
        other: "keep this",
      };

      const result = stripImagesFromObject(input);

      expect(result).toEqual({
        image_data: IMAGE_STRIPPED_PLACEHOLDER,
        other: "keep this",
      });
    });

    test("handles nested objects", () => {
      const input = {
        result: {
          images: [
            {
              data: "data:image/jpeg;base64,/9j/4AAQ...",
              mimeType: "image/jpeg",
            },
          ],
          text: "Screenshot taken",
        },
      };

      const result = stripImagesFromObject(input) as {
        result: {
          images: Array<{ data: string; mimeType: string }>;
          text: string;
        };
      };

      expect(result.result.text).toBe("Screenshot taken");
      expect(result.result.images[0].data).toBe(IMAGE_STRIPPED_PLACEHOLDER);
      expect(result.result.images[0].mimeType).toBe("image/jpeg");
    });

    test("preserves non-image data", () => {
      const input = {
        name: "test",
        count: 42,
        items: ["a", "b", "c"],
        nested: { value: "keep" },
      };

      const result = stripImagesFromObject(input);

      expect(result).toEqual(input);
    });
  });

  describe("stripImagesFromMessages", () => {
    test("converts image blocks to text in tool-result parts", () => {
      const messages: UiMessage[] = [
        {
          id: "msg1",
          role: "assistant",
          parts: [
            {
              type: "tool-result",
              toolCallId: "call_123",
              toolName: "browser_take_screenshot",
              result: [
                { type: "text", text: "Screenshot captured" },
                {
                  type: "image",
                  data: "data:image/png;base64,iVBORw0KGgo...",
                  mimeType: "image/png",
                },
              ],
            },
          ],
        },
      ];

      const result = stripImagesFromMessages(messages);

      // Text block preserved
      const toolResult = result[0].parts?.[0].result as Array<{
        type: string;
        text: string;
      }>;
      expect(toolResult[0].text).toBe("Screenshot captured");
      // Image block converted to text block
      expect(toolResult[1].type).toBe("text");
      expect(toolResult[1].text).toBe(IMAGE_STRIPPED_PLACEHOLDER);
    });

    test("converts direct image parts to text parts", () => {
      const messages: UiMessage[] = [
        {
          id: "msg1",
          role: "user",
          parts: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/png",
                data: "data:image/png;base64,iVBORw0KGgo...",
              },
            },
          ],
        },
      ];

      const result = stripImagesFromMessages(messages);

      // Image part converted to text part
      const part = result[0].parts?.[0];
      expect(part?.type).toBe("text");
      expect(part?.text).toBe(IMAGE_STRIPPED_PLACEHOLDER);
      // Original source should not exist
      expect(part?.source).toBeUndefined();
    });

    test("preserves text parts", () => {
      const messages: UiMessage[] = [
        {
          id: "msg1",
          role: "assistant",
          parts: [
            { type: "text", text: "Here is the analysis of the screenshot..." },
          ],
        },
      ];

      const result = stripImagesFromMessages(messages);

      expect(result).toEqual(messages);
    });

    test("handles messages without parts", () => {
      const messages: UiMessage[] = [{ id: "msg1", role: "system" }];

      const result = stripImagesFromMessages(messages);

      expect(result).toEqual(messages);
    });

    test("handles mixed content", () => {
      const messages: UiMessage[] = [
        {
          id: "msg1",
          role: "assistant",
          parts: [
            { type: "text", text: "Analyzing..." },
            {
              type: "tool-call",
              toolCallId: "call_1",
              toolName: "browser_take_screenshot",
            },
          ],
        },
        {
          id: "msg2",
          role: "tool",
          parts: [
            {
              type: "tool-result",
              toolCallId: "call_1",
              toolName: "browser_take_screenshot",
              result: {
                image_data: "A".repeat(1500),
                description: "Homepage screenshot",
              },
            },
          ],
        },
        {
          id: "msg3",
          role: "assistant",
          parts: [{ type: "text", text: "The page shows a welcome message." }],
        },
      ];

      const result = stripImagesFromMessages(messages);

      // Tool call preserved
      expect(result[0].parts?.[1]?.toolName).toBe("browser_take_screenshot");
      // Image stripped from tool result
      const toolResult = result[1].parts?.[0]?.result as {
        image_data: string;
        description: string;
      };
      expect(toolResult.image_data).toBe(IMAGE_STRIPPED_PLACEHOLDER);
      // Description preserved
      expect(toolResult.description).toBe("Homepage screenshot");
      // Text preserved
      expect(result[2].parts?.[0]?.text).toBe(
        "The page shows a welcome message.",
      );
    });
  });
});
