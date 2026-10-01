import { describe, expect, test } from "vitest";
import {
  applyStrReplaceEdits,
  buildAppliedEditExcerpts,
} from "./str-replace-edits";

const LABELS = { sourceNoun: "HTML", rereadHint: "re-read the document." };

function apply(
  source: string,
  edits: Array<{ old_str: string; new_str: string }>,
) {
  return applyStrReplaceEdits(source, edits, LABELS);
}

/** Apply edits and render the excerpt block the edit tools append on success. */
function excerptFor(
  source: string,
  edits: Array<{ old_str: string; new_str: string }>,
) {
  const { content, spans } = apply(source, edits);
  return { content, excerpt: buildAppliedEditExcerpts(content, spans) };
}

function thrownMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected the edit to be rejected");
}

describe("applyStrReplaceEdits", () => {
  test("an ambiguous (multi-match) edit is rejected with the match count", () => {
    expect(() =>
      apply("<p>x</p><p>x</p>", [{ old_str: "x", new_str: "y" }]),
    ).toThrow("matched 2 times");
  });

  test("a self-overlapping old_str is rejected as ambiguous, not silently replaced", () => {
    // "aa" matches at two overlapping positions in "aaa". The uniqueness guard
    // must see both and reject, never collapse to one and edit the first.
    expect(() =>
      apply("<pre>aaa</pre>", [{ old_str: "aa", new_str: "bb" }]),
    ).toThrow("matched 2 times");
  });

  test("a no-op edit amid real edits is skipped while the rest apply", () => {
    const result = apply("<div>alpha beta gamma</div>", [
      { old_str: "alpha", new_str: "ALPHA" },
      { old_str: "beta", new_str: "beta" }, // no-op → skipped
      { old_str: "gamma", new_str: "GAMMA" },
    ]);
    expect(result.content).toBe("<div>ALPHA beta GAMMA</div>");
    expect(result.skipped).toEqual([
      expect.objectContaining({ editNumber: 2 }),
    ]);
    // Excerpt labels keep the caller's numbering across the skipped edit.
    expect(result.spans.map((s) => s.editNumber)).toEqual([1, 3]);
  });

  test("a 0-match edit whose old_str differs only in whitespace is applied to the real span", () => {
    // The source has a triple space; old_str has one. Exact match fails, but
    // the collapsed-whitespace match is unique, so the edit lands on the real
    // current span rather than erroring.
    const { content } = apply(
      "<html><head></head><body><p>Hello   World</p></body></html>",
      [{ old_str: "Hello World", new_str: "Hi" }],
    );
    expect(content).toBe("<html><head></head><body><p>Hi</p></body></html>");
  });

  test("a whitespace near-miss at the very end of the document applies over the full span", () => {
    // End-boundary case: the matched span is the last thing in the document.
    const { content } = apply(
      "<html><head></head><body></body></html>\n\n<!-- TAIL    MARKER -->",
      [{ old_str: "TAIL MARKER", new_str: "x" }],
    );
    expect(content).toBe(
      "<html><head></head><body></body></html>\n\n<!-- x -->",
    );
  });

  test("an edit whose old_str drifted in indentation lands on the real source", () => {
    // The model reconstructs a block with different leading whitespace than the
    // stored source; collapsed-whitespace matching applies it uniquely.
    const stored = [
      "<html><head></head><body>",
      "  <ul>",
      "    <li>one</li>",
      "  </ul>",
      "</body></html>",
    ].join("\n");
    const { content } = apply(stored, [
      {
        old_str: "<ul>\n<li>one</li>\n</ul>",
        new_str: "<ol><li>one</li></ol>",
      },
    ]);
    expect(content).toBe(
      [
        "<html><head></head><body>",
        "  <ol><li>one</li></ol>",
        "</body></html>",
      ].join("\n"),
    );
  });

  test("a genuine (non-whitespace) content drift still errors, not silently mis-applied", () => {
    // old_str differs from the source by a real character (43 vs 42), not just
    // whitespace, so it must not auto-apply — it stays a 0-match error.
    expect(() =>
      apply("<html><head></head><body><span>42</span></body></html>", [
        { old_str: "<span>43</span>", new_str: "<span>99</span>" },
      ]),
    ).toThrow("0 matches");
  });

  test("a whitespace-only old_str with no near-miss falls back to the caller's reread hint", () => {
    // "\t" matches nothing exactly and normalizes to empty, so no anchor hint
    // applies and the caller-injected recovery sentence is used instead.
    const message = thrownMessage(() =>
      apply("<html><head></head><body>nogapshere</body></html>", [
        { old_str: "\t", new_str: "x" },
      ]),
    );
    expect(message).toContain("0 matches");
    expect(message).toContain(LABELS.rereadHint);
  });

  test("a 0-match edit with a one-char drift surfaces the current text via a unique anchor", () => {
    const source = [
      "<html><head><title>Dash</title></head><body>",
      '<div class="metrics-container-unique-anchor">',
      "<span>42</span>",
      "</div>",
      "</body></html>",
    ].join("\n");
    // old_str reconstructs the block from memory with 42 -> 43 on the span line.
    const message = thrownMessage(() =>
      apply(source, [
        {
          old_str:
            '<div class="metrics-container-unique-anchor">\n<span>43</span>',
          new_str: "<span>99</span>",
        },
      ]),
    );
    expect(message).toContain("0 matches");
    // the window around the unique anchor shows the real current value (42)
    expect(message).toContain("<span>42</span>");
    expect(message).not.toContain(LABELS.rereadHint);
  });
});

describe("buildAppliedEditExcerpts", () => {
  test("a later length-changing edit shifts an earlier excerpt to its final position", () => {
    // Edit 1 lands AFTER edit 2's region, and edit 2 grows the document by more
    // than the excerpt context window — if edit 1's recorded span is not
    // shifted by that delta, its window slices a region entirely before the
    // real <p>OMEGA</p>. Spacers keep the two context windows from overlapping.
    const spacer = `<i>${"x".repeat(600)}</i>`;
    const grown = `long-${"a".repeat(500)}`;
    const { excerpt } = excerptFor(
      `<html><head></head><body><p>alpha</p>${spacer}<p>omega</p></body></html>`,
      [
        { old_str: "omega", new_str: "OMEGA" },
        { old_str: "alpha", new_str: grown },
      ],
    );
    expect(excerpt).toContain("<p>OMEGA</p>");
    expect(excerpt).toContain(`<p>${grown}</p>`);
  });

  test("a chained overwrite excerpt shows the final text, never the overwritten intermediate", () => {
    const { content, excerpt } = excerptFor(
      "<html><head></head><body><p>foo</p></body></html>",
      [
        { old_str: "foo", new_str: "interim" },
        { old_str: "interim", new_str: "settled" },
      ],
    );
    expect(content).toContain("<p>settled</p>");
    expect(excerpt).toContain("<p>settled</p>");
    // the first edit's region was overwritten; its excerpt must not resurrect it
    expect(excerpt).not.toContain("interim");
  });

  test("a deletion edit excerpt marks the deletion point", () => {
    const { excerpt } = excerptFor(
      "<html><head></head><body><p>keep</p><p>gone</p><p>tail</p></body></html>",
      [{ old_str: "<p>gone</p>", new_str: "" }],
    );
    expect(excerpt).toContain("<p>keep</p>⟦deleted⟧<p>tail</p>");
  });

  test("a whitespace-fallback edit excerpts the real applied span", () => {
    const { excerpt } = excerptFor(
      "<html><head></head><body><p>Hello   World</p></body></html>",
      [{ old_str: "Hello World", new_str: "Hi" }],
    );
    expect(excerpt).toContain("<p>Hi</p>");
  });

  test("excerpts cap the number of edits shown", () => {
    const tokens = ["one", "two", "three", "four", "five", "six", "seven"];
    // Spacers longer than the excerpt context window keep each edit's window
    // from covering its neighbours, so the withheld tail is genuinely absent.
    const spacer = `<i>${"x".repeat(400)}</i>`;
    const { content, excerpt } = excerptFor(
      `<html><head></head><body>${tokens.map((t) => `<p>${t}</p>`).join(spacer)}</body></html>`,
      tokens.map((t) => ({ old_str: `<p>${t}</p>`, new_str: `<b>${t}</b>` })),
    );
    expect(excerpt).toContain("+2 more edits");
    // the omitted edits still applied — only their excerpts are withheld
    expect(content).toContain("<b>seven</b>");
    expect(excerpt).not.toContain("<b>seven</b>");
  });

  test("an overlong inserted span is elided in its excerpt", () => {
    const big = `<div>${"y".repeat(4000)}</div>`;
    const { excerpt } = excerptFor(
      "<html><head></head><body><p>stub</p></body></html>",
      [{ old_str: "<p>stub</p>", new_str: big }],
    );
    expect(excerpt).toContain("[elided]");
    // the excerpt block stays bounded instead of echoing the whole insertion
    expect(excerpt.length).toBeLessThan(big.length);
  });

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
