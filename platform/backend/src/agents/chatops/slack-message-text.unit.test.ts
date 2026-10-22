import { describe, expect, test } from "vitest";
import { slackMessageText, slackThreadMessageText } from "./slack-message-text";

describe("Slack composer text recovery", () => {
  test("preserves an existing fallback without adding block text twice", () => {
    const text = "> report\n<@UBOT123> create a task";
    expect(
      slackMessageText({
        text,
        blocks: [
          {
            type: "rich_text",
            elements: [{ type: "text", text: "duplicate" }],
          },
        ],
      }),
    ).toBe(text);
  });
  test("preserves quote, list, code and link boundaries", () => {
    expect(
      slackMessageText({
        blocks: [
          {
            type: "rich_text",
            elements: [
              {
                type: "rich_text_quote",
                elements: [{ type: "text", text: "first\nsecond" }],
              },
              {
                type: "rich_text_list",
                style: "ordered",
                elements: [
                  {
                    type: "rich_text_section",
                    elements: [{ type: "text", text: "item" }],
                  },
                ],
              },
              {
                type: "rich_text_preformatted",
                elements: [{ type: "text", text: "a > b" }],
              },
              {
                type: "rich_text_section",
                elements: [
                  { type: "link", url: "https://example.com", text: "report" },
                ],
              },
            ],
          },
        ],
      }),
    ).toBe(
      "> first\n> second\n1. item\n```\na &gt; b\n```\n<https://example.com|report>",
    );
  });
  test("encodes literal markup while retaining real user mentions", () => {
    expect(
      slackMessageText({
        blocks: [
          {
            type: "rich_text",
            elements: [
              {
                type: "rich_text_section",
                elements: [
                  { type: "text", text: "literal <@UBOT123> & " },
                  { type: "user", user_id: "UREAL" },
                ],
              },
            ],
          },
        ],
      }),
    ).toBe("literal &lt;@UBOT123&gt; &amp; <@UREAL>");
  });
  test("empty quote and code blocks do not invent message content", () => {
    expect(
      slackMessageText({
        blocks: [
          {
            type: "rich_text",
            elements: [
              {
                type: "rich_text_quote",
                elements: [{ type: "text", text: " " }],
              },
              { type: "rich_text_preformatted", elements: [] },
            ],
          },
        ],
      }),
    ).toBe("");
  });
  test.each([
    undefined,
    null,
    {},
    [
      null,
      { type: "actions", elements: [{ type: "text", text: "button label" }] },
    ],
  ])("ignores malformed or non-content blocks: %j", (blocks) => {
    expect(slackMessageText({ blocks })).toBe("");
  });
});

describe("Slack thread-history text recovery", () => {
  test("reads an attachment's fallback only when it has no other content", () => {
    expect(
      slackThreadMessageText({
        text: "",
        attachments: [
          { fallback: "Disk usage 91% on db-1" },
          { fallback: "summary", title: "Disk usage", text: "91% on db-1" },
        ],
      }),
    ).toBe("Disk usage 91% on db-1\nDisk usage\n91% on db-1");
  });

  test("caps recovered attachment text", () => {
    const text = slackThreadMessageText({
      attachments: [{ text: "x".repeat(10_000) }],
    });
    expect(text.length).toBeLessThan(10_000);
    expect(text.endsWith("…")).toBe(true);
  });
});
