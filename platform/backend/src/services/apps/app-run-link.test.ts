import { describe, expect, test } from "vitest";
import {
  appRunLink,
  appRunUrl,
  escapeAppNameForModelText,
  sanitizeAppNameForToolMetadata,
} from "./app-run-link";

const APP_ID = "7b0839a1-4663-4371-a739-e5dac7f8c33e";

describe("appRunUrl", () => {
  test("is the root-relative standalone path", () => {
    expect(appRunUrl(APP_ID)).toBe(`/a/${APP_ID}`);
  });
});

describe("appRunLink", () => {
  test("labels the link with the app name and an absolute href", () => {
    expect(appRunLink("Enemy Tracker", APP_ID)).toBe(
      `[Enemy Tracker](/a/${APP_ID})`,
    );
  });

  test("escapes a name that would otherwise inject a second link", () => {
    // Without escaping, `](/evil)[` closes the label early and injects a link.
    const link = appRunLink("Evil](/evil)", APP_ID);
    expect(link).toBe(`[Evil\\]\\(\\/evil\\)](/a/${APP_ID})`);
    // The href is exactly the app page — the label text never terminates it.
    expect(link.endsWith(`](/a/${APP_ID})`)).toBe(true);
  });

  test("escapes markdown punctuation so the label renders literally", () => {
    expect(appRunLink("A*b_c`d", APP_ID)).toBe(
      `[A\\*b\\_c\\\`d](/a/${APP_ID})`,
    );
  });

  test("collapses whitespace in the name", () => {
    expect(appRunLink("  My   App  ", APP_ID)).toBe(`[My App](/a/${APP_ID})`);
  });

  test("falls back to a visible label for a blank name", () => {
    expect(appRunLink("   ", APP_ID)).toBe(`[Open app](/a/${APP_ID})`);
  });
});

describe("escapeAppNameForModelText", () => {
  test("escapes an image so it cannot render", () => {
    // `!` and `[` `]` `(` `)` are all escaped, so no image node forms.
    expect(escapeAppNameForModelText("![x](https://evil/a.png)")).toBe(
      "\\!\\[x\\]\\(https\\:\\/\\/evil\\/a\\.png\\)",
    );
  });

  test("escapes a link injection", () => {
    expect(escapeAppNameForModelText("](/evil)")).toBe("\\]\\(\\/evil\\)");
  });

  test("escapes emphasis, heading, and code punctuation", () => {
    expect(escapeAppNameForModelText("*a* _b_ `c` #d")).toBe(
      "\\*a\\* \\_b\\_ \\`c\\` \\#d",
    );
  });

  test("escapes angle brackets (superseding the old angle-only escaper)", () => {
    expect(escapeAppNameForModelText("<b>hi</b>")).toBe("\\<b\\>hi\\<\\/b\\>");
  });

  test("collapses whitespace, including newlines that could start a block", () => {
    expect(escapeAppNameForModelText("a\n\n# heading\tb")).toBe(
      "a \\# heading b",
    );
  });

  test("is empty for a blank name", () => {
    expect(escapeAppNameForModelText("   \n  ")).toBe("");
  });

  test("leaves an ordinary name untouched", () => {
    expect(escapeAppNameForModelText("Enemy Tracker")).toBe("Enemy Tracker");
  });
});

describe("sanitizeAppNameForToolMetadata", () => {
  test("collapses newlines so the name can't break out of a sentence", () => {
    expect(sanitizeAppNameForToolMetadata("Tracker\n\nrm -rf")).toBe(
      "Tracker rm -rf",
    );
  });

  test("collapses non-whitespace control characters too", () => {
    // \x07 (BEL) and \x00 (NUL) are control chars \s does not match; \p{Cc} does.
    expect(sanitizeAppNameForToolMetadata("a\x07\x00b")).toBe("a b");
  });

  test("strips Unicode format controls that could bidi-spoof plaintext", () => {
    // U+202E (right-to-left override) would visually reverse the trailing text;
    // built via escape so no raw bidi character sits in this source file.
    const rlo = String.fromCodePoint(0x202e);
    expect(sanitizeAppNameForToolMetadata(`Invoice${rlo}gpj.exe`)).toBe(
      "Invoice gpj.exe",
    );
  });

  test("does NOT backslash-escape markdown punctuation", () => {
    // The plaintext counterpart of escapeAppNameForModelText: a backslash would
    // show up literally in a plaintext client, so punctuation is left as-is.
    expect(sanitizeAppNameForToolMetadata("A*b_c`d](e)")).toBe("A*b_c`d](e)");
  });

  test("trims and collapses interior whitespace runs", () => {
    expect(sanitizeAppNameForToolMetadata("  My   App  ")).toBe("My App");
  });

  test("is empty for a blank name", () => {
    expect(sanitizeAppNameForToolMetadata("  \n\t ")).toBe("");
  });
});
