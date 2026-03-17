import { describe, expect, it } from "vitest";
import {
  sanitizeChatLinks,
  validateChatLink,
} from "./chat-links-editor.utils";

describe("chat-links-editor utils", () => {
  describe("sanitizeChatLinks", () => {
    it("trims values and drops fully empty rows", () => {
      expect(
        sanitizeChatLinks([
          {
            label: " Docs ",
            url: " https://docs.example.com ",
          },
          {
            label: " ",
            url: " ",
          },
        ]),
      ).toEqual([
        {
          label: "Docs",
          url: "https://docs.example.com",
        },
      ]);
    });
  });

  describe("validateChatLink", () => {
    it("allows a fully empty row so save can discard it", () => {
      expect(
        validateChatLink({
          label: " ",
          url: " ",
        }),
      ).toEqual({});
    });

    it("requires a label when a URL is present", () => {
      expect(
        validateChatLink({
          label: "",
          url: "https://docs.example.com",
        }),
      ).toEqual({
        label: "Enter a label.",
        url: undefined,
      });
    });

    it("rejects labels longer than 25 characters", () => {
      expect(
        validateChatLink({
          label: "A".repeat(26),
          url: "https://docs.example.com",
        }),
      ).toEqual({
        label: "Label must be 25 characters or fewer.",
        url: undefined,
      });
    });

    it("rejects invalid URLs", () => {
      expect(
        validateChatLink({
          label: "Docs",
          url: "not-a-url",
        }),
      ).toEqual({
        label: undefined,
        url: "Enter a valid HTTP or HTTPS URL.",
      });
    });
  });
});
