import { describe, expect, test } from "@/test";
import {
  applyStrReplaceEdits,
  buildAppliedEditExcerpts,
} from "./str-replace-edits";

const LABELS = { sourceNoun: "HTML", rereadHint: "re-read the document." };

describe("buildAppliedEditExcerpts", () => {
  test("fences echoed source so an injected code fence can't break out", () => {
    // A model can fill edited source with markdown; here a triple-backtick fence
    // wrapping a heading and image. The excerpt must enclose it in a LONGER
    // fence so the inner ``` cannot close early and render as markdown.
    const injected = "```\n# pwned\n![x](http://evil/a.png)\n```";
    const { content, spans } = applyStrReplaceEdits(
      "start MARKER end",
      [{ old_str: "MARKER", new_str: injected }],
      LABELS,
    );
    const excerpt = buildAppliedEditExcerpts(content, spans);
    // Wrapper grew to a 4-backtick fence (the only 4-run in the output)...
    expect(excerpt).toContain("````\n");
    // ...and the edited source is shown verbatim inside it.
    expect(excerpt).toContain(injected);
  });

  test("honors the language hint on the fence", () => {
    const { content, spans } = applyStrReplaceEdits(
      "aXb",
      [{ old_str: "X", new_str: "Y" }],
      LABELS,
    );
    expect(buildAppliedEditExcerpts(content, spans, "html")).toContain(
      "```html\n",
    );
  });

  // A UTF-16 code unit that is half of an astral character: a high surrogate
  // with no low after it, or a low with no high before it. JSON.stringify keeps
  // these as a bare \uD83D escape, which is syntactically valid JSON text but
  // has no UTF-8 encoding — so a provider rejects the whole body ("the request
  // body is not valid JSON"). The excerpt is echoed into the tool result and
  // stored in the transcript, so one stranded half wedges every later turn of
  // that conversation until the history is dropped.
  const LONE_SURROGATE =
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

  // 📎 — astral, so one character but two UTF-16 code units.
  const EMOJI = "\u{1F4CE}";

  test("a context window never strands half an emoji at its edge", () => {
    // Sweep the emoji across the trailing context edge: at one of these offsets
    // it straddles it exactly, and a raw slice cuts the pair in half.
    for (let pad = 140; pad <= 160; pad++) {
      const { content, spans } = applyStrReplaceEdits(
        `${EMOJI}${"a".repeat(pad)}MARKER${"a".repeat(pad)}${EMOJI}`,
        [{ old_str: "MARKER", new_str: "EDITED" }],
        LABELS,
      );
      const excerpt = buildAppliedEditExcerpts(content, spans);
      expect(excerpt, `trailing pad ${pad}`).not.toMatch(LONE_SURROGATE);
    }
  });

  test("a leading context window never strands half an emoji", () => {
    // Same sweep on the leading edge, where the window start moves instead.
    for (let pad = 140; pad <= 160; pad++) {
      const { content, spans } = applyStrReplaceEdits(
        `${"a".repeat(20)}${EMOJI}${"a".repeat(pad)}MARKER`,
        [{ old_str: "MARKER", new_str: "EDITED" }],
        LABELS,
      );
      const excerpt = buildAppliedEditExcerpts(content, spans);
      expect(excerpt, `leading pad ${pad}`).not.toMatch(LONE_SURROGATE);
    }
  });

  test("the mid-span elision never strands half an emoji", () => {
    // An inserted span past the 600-char cap is elided in the middle; sweep the
    // emoji across both cut points.
    for (let pad = 285; pad <= 305; pad++) {
      const inserted = `${"a".repeat(pad)}${EMOJI}${"b".repeat(900)}${EMOJI}${"c".repeat(pad)}`;
      const { content, spans } = applyStrReplaceEdits(
        "start MARKER end",
        [{ old_str: "MARKER", new_str: inserted }],
        LABELS,
      );
      const excerpt = buildAppliedEditExcerpts(content, spans);
      expect(excerpt, `elision pad ${pad}`).toContain("[elided]");
      expect(excerpt, `elision pad ${pad}`).not.toMatch(LONE_SURROGATE);
    }
  });

  test("a whole emoji inside the window survives intact", () => {
    // The guard drops a split character; it must not drop one that fits.
    const { content, spans } = applyStrReplaceEdits(
      "start MARKER end",
      [{ old_str: "MARKER", new_str: `hello ${EMOJI} world` }],
      LABELS,
    );
    expect(buildAppliedEditExcerpts(content, spans)).toContain(
      `hello ${EMOJI} world`,
    );
  });
});
