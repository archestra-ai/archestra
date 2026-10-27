import { describe, expect, test } from "vitest";
import {
  jiraMentionsAccount,
  jiraMessageText,
  jiraReplyDocument,
  parseJiraApprovalCommand,
} from "./jira-message";

describe("Jira mention identities", () => {
  test("uses ADF account ids and strips only this bot's mention", () => {
    const body = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "mention",
              attrs: { id: "bot-account", text: "@Helpful Bot" },
            },
            { type: "text", text: " ask " },
            {
              type: "mention",
              attrs: { id: "other-account", text: "@Someone" },
            },
            { type: "text", text: " about this" },
          ],
        },
      ],
    };
    expect(jiraMentionsAccount(body, "bot-account")).toBe(true);
    expect(jiraMentionsAccount(body, "Helpful Bot")).toBe(false);
    expect(jiraMessageText(body, "bot-account")).toBe(
      "ask @Someone about this",
    );
    expect(
      jiraMentionsAccount(
        { type: "text", text: "@Helpful Bot" },
        "bot-account",
      ),
    ).toBe(false);
  });

  test("matches complete wiki mentions and escapes account-id regex syntax", () => {
    expect(jiraMentionsAccount("[~accountid:bot.123] hello", "bot.123")).toBe(
      true,
    );
    expect(jiraMentionsAccount("[~bot.1234]", "bot.123")).toBe(false);
    expect(jiraMentionsAccount("[~botx123]", "bot.123")).toBe(false);
    expect(jiraMessageText("[~bot.123] hello [~someone]", "bot.123")).toBe(
      "hello [~someone]",
    );
  });
});

test("reply text remains literal ADF text without executable mentions", () => {
  const text = '[~accountid:bot]\n{"type":"mention"}\n\nSecond paragraph';
  const doc = jiraReplyDocument(text);
  expect(jiraMessageText(doc)).toBe(text);
  expect(jiraMentionsAccount(doc, "bot")).toBe(false);
});

test("UI URLs become safe clickable links while unsafe schemes stay literal text", () => {
  const text =
    "Review https://app.example.test/chat/runs/run-123. javascript:alert(1) [click](data:text/html,example)";
  const doc = jiraReplyDocument(text);
  expect(doc.content[0].content).toContainEqual({
    type: "text",
    text: "https://app.example.test/chat/runs/run-123",
    marks: [
      {
        type: "link",
        attrs: { href: "https://app.example.test/chat/runs/run-123" },
      },
    ],
  });
  expect(jiraMessageText(doc)).toBe(text);
  const marks = doc.content.flatMap((paragraph) =>
    paragraph.content.flatMap((node) => ("marks" in node ? node.marks : [])),
  );
  expect(marks).toHaveLength(1);
  expect(
    JSON.stringify(jiraReplyDocument("https://secret@example.test/path")),
  ).not.toContain('"marks"');
});

test("approval commands are whole messages with one optional opaque id", () => {
  expect(parseJiraApprovalCommand({ text: "approve request-123" })).toEqual({
    approved: true,
    approvalId: "request-123",
  });
  expect(parseJiraApprovalCommand({ text: " Decline " })).toEqual({
    approved: false,
  });
  expect(
    parseJiraApprovalCommand({ text: "please approve this deployment" }),
  ).toBeNull();
  expect(
    parseJiraApprovalCommand({ text: "approve request-123 and request-456" }),
  ).toBeNull();
  expect(
    parseJiraApprovalCommand({ text: "approve https://example.test" }),
  ).toBeNull();
});
