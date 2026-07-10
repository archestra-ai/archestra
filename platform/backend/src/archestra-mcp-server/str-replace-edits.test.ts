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
});
