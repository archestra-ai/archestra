import { describe, expect, test } from "vitest";
import { stripHtmlEmail, stripHtmlTags } from "./strip-html";

describe("stripHtmlTags", () => {
  test("strips simple HTML tags", () => {
    expect(stripHtmlTags("<p>Hello world</p>")).toBe("Hello world");
  });

  test("handles nested tags", () => {
    const html = "<p>Text with <strong>bold</strong> and <em>italic</em></p>";
    expect(stripHtmlTags(html)).toBe("Text with bold and italic");
  });

  test("replaces block elements with newlines", () => {
    const html = "<p>First</p><p>Second</p>";
    const result = stripHtmlTags(html);
    expect(result).toContain("First");
    expect(result).toContain("Second");
    expect(result).toContain("\n");
  });

  test("decodes HTML entities", () => {
    expect(stripHtmlTags("&amp; &lt; &gt; &quot; &#39;")).toBe("& < > \" '");
  });

  test("returns empty string for empty input", () => {
    expect(stripHtmlTags("")).toBe("");
  });

  test("decodes &nbsp; to space", () => {
    expect(stripHtmlTags("hello&nbsp;world")).toBe("hello world");
  });

  test("collapses excessive newlines", () => {
    const html = "<p>A</p><p></p><p></p><p>B</p>";
    const result = stripHtmlTags(html);
    expect(result).not.toContain("\n\n\n");
  });

  test("strips tags iteratively when nested markup reconstitutes outer tags", () => {
    const html = "<<script>alert(1)</script>";
    expect(stripHtmlTags(html)).toBe("alert(1)");
  });

  test("strips unterminated tag fragments after entity decoding", () => {
    expect(stripHtmlTags("safe &lt;script attr=")).toBe("safe");
  });

  test("preserves literal less-than text that is not tag-like", () => {
    expect(stripHtmlTags("1 &lt; 5")).toBe("1 < 5");
  });
});

describe("stripHtmlEmail", () => {
  test("converts simple HTML to plain text", () => {
    expect(stripHtmlEmail("<p>Hello world</p>")).toBe("Hello world");
  });

  test("preserves line breaks from br tags", () => {
    const html = "Line 1<br>Line 2<br/>Line 3";
    expect(stripHtmlEmail(html)).toBe("Line 1\nLine 2\nLine 3");
  });

  test("preserves paragraph structure", () => {
    expect(stripHtmlEmail("<p>Paragraph 1</p><p>Paragraph 2</p>")).toBe(
      "Paragraph 1\n\nParagraph 2",
    );
  });

  test("converts blockquotes to quoted text format", () => {
    const html =
      "<p>My reply</p><blockquote>Original message line 1<br>Original message line 2</blockquote>";
    const result = stripHtmlEmail(html);

    expect(result).toContain("My reply");
    expect(result).toContain("> Original message line 1");
    expect(result).toContain("> Original message line 2");
  });

  test("handles nested blockquotes in email threads", () => {
    const html = `
      <p>User's second reply</p>
      <blockquote>
        <p>Agent's response</p>
        <blockquote>
          <p>User's original message</p>
        </blockquote>
      </blockquote>
    `;
    const result = stripHtmlEmail(html);

    expect(result).toContain("User's second reply");
    expect(result).toContain("> Agent's response");
    expect(result).toContain("> User's original message");
  });

  test("converts horizontal rules to separator lines", () => {
    const html = "<p>Above</p><hr><p>Below</p>";
    const result = stripHtmlEmail(html);

    expect(result).toContain("Above");
    expect(result).toContain("---");
    expect(result).toContain("Below");
  });

  test("decodes HTML entities", () => {
    const html =
      "<p>Tom &amp; Jerry &lt;hello@example.com&gt; said &quot;hi&quot;</p>";
    expect(stripHtmlEmail(html)).toBe(
      'Tom & Jerry <hello@example.com> said "hi"',
    );
  });

  test("prevents double-unescaping of HTML entities", () => {
    const html = "<p>Code: &amp;lt;script&amp;gt; and &amp;amp;</p>";
    const result = stripHtmlEmail(html);

    expect(result).toBe("Code: &lt;script&gt; and &amp;");
    expect(result).not.toContain("<script>");
  });

  test("handles realistic Outlook email reply HTML", () => {
    const html = `
      <html>
      <body>
        <div>Thanks for your response!</div>
        <div>&nbsp;</div>
        <hr style="display:inline-block;width:98%">
        <div id="divRplyFwdMsg" dir="ltr">
          <b>From:</b> Agent &lt;agents+agent-abc@example.com&gt;<br>
          <b>Sent:</b> Monday, January 15, 2026 10:00 AM<br>
          <b>To:</b> User &lt;user@example.com&gt;<br>
          <b>Subject:</b> Re: Question<br>
        </div>
        <div>&nbsp;</div>
        <div>Here is the agent's previous response with helpful information.</div>
      </body>
      </html>
    `;
    const result = stripHtmlEmail(html);

    expect(result).toContain("Thanks for your response!");
    expect(result).toContain("---");
    expect(result).toContain(
      "Here is the agent's previous response with helpful information",
    );
    expect(result).toContain("From:");
    expect(result).toContain("agents+agent-abc@example.com");
  });

  test("preserves full conversation history in multi-turn thread", () => {
    const html = `
      <div>This is my third message to the agent.</div>
      <blockquote>
        <div>Agent's second response: I've processed your request.</div>
        <blockquote>
          <div>User's second message: Can you help me with something else?</div>
          <blockquote>
            <div>Agent's first response: Hello! How can I help you?</div>
            <blockquote>
              <div>User's first message: Hello agent!</div>
            </blockquote>
          </blockquote>
        </blockquote>
      </blockquote>
    `;
    const result = stripHtmlEmail(html);

    expect(result).toContain("This is my third message to the agent");
    expect(result).toContain("> Agent's second response");
    expect(result).toContain("> User's second message");
    expect(result).toContain("> Agent's first response");
    expect(result).toContain("> User's first message");
  });
});
