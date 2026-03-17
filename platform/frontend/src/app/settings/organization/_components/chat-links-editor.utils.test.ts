import { describe, expect, it } from "vitest";
import { sanitizeChatLinks, validateChatLink } from "./chat-links-editor.utils";

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
      });
    });

    it("does not require a URL during live validation when only the label is filled", () => {
      expect(
        validateChatLink({
          label: "Docs",
          url: "",
        }),
      ).toEqual({
        label: undefined,
      });
    });

    it("requires a URL during save validation when only the label is filled", () => {
      expect(
        validateChatLink(
          {
            label: "Docs",
            url: "",
          },
          { requireComplete: true },
        ),
      ).toEqual({
        url: "Enter a valid HTTP or HTTPS URL.",
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
      });
    });

    it("rejects invalid URLs", () => {
      expect(
        validateChatLink({
          label: "Docs",
          url: "not-a-url",
        }),
      ).toEqual({
        url: "Enter a valid HTTP or HTTPS URL.",
      });
    });
  });
});
