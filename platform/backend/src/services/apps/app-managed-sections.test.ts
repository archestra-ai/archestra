import { describe, expect, it } from "vitest";
import { ApiError } from "@/types";
import {
  applySectionMutations,
  composeManagedDocument,
  isManagedDocument,
  type ManagedSections,
  parseManagedSections,
} from "./app-managed-sections";

const SAMPLE: ManagedSections = {
  title: "Reading list",
  css: ".book { display: grid; gap: 0.5rem; }",
  body: '<section><h1>Reading list</h1><div id="books"></div></section>',
  javascript: "await archestra.ready;\nconst x = 1;",
};

function base(overrides: Partial<ManagedSections> = {}): string {
  return composeManagedDocument({ ...SAMPLE, ...overrides });
}

function expectApiError(fn: () => unknown): ApiError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error("expected an ApiError to be thrown");
}

describe("composeManagedDocument + parseManagedSections", () => {
  it("composes a managed document that round-trips byte-exact for css/body/js", () => {
    const html = base();
    expect(isManagedDocument(html)).toBe(true);
    const parsed = parseManagedSections(html);
    expect(parsed).toEqual(SAMPLE);
  });

  it("preserves > inside css, attributes, and script bodies", () => {
    const sections: ManagedSections = {
      title: "t",
      css: ".a > .b { color: red; }",
      body: '<p data-x=">">hi</p>',
      javascript: "const gt = 1 > 0;",
    };
    const parsed = parseManagedSections(composeManagedDocument(sections));
    expect(parsed).toEqual(sections);
  });

  it("preserves CRLF and astral characters in raw sections", () => {
    const sections: ManagedSections = {
      title: "t",
      css: "",
      body: "<p>🚀</p>",
      javascript: 'const e = "🚀";\r\nfoo();',
    };
    const parsed = parseManagedSections(composeManagedDocument(sections));
    expect(parsed?.javascript).toBe('const e = "🚀";\r\nfoo();');
    expect(parsed?.body).toBe("<p>🚀</p>");
  });

  it("escapes the title and decodes it back without double-escaping", () => {
    const html = base({ title: "R&D <draft>" });
    // Re-editing the parsed title must not accumulate entities.
    const once = parseManagedSections(html)?.title;
    expect(once).toBe("R&D <draft>");
    const twice = parseManagedSections(base({ title: once as string }))?.title;
    expect(twice).toBe("R&D <draft>");
  });

  it("normalizes CRLF in the title", () => {
    const parsed = parseManagedSections(base({ title: "a\r\nb" }));
    expect(parsed?.title).toBe("a\nb");
  });

  it("handles empty sections", () => {
    const sections: ManagedSections = {
      title: "",
      css: "",
      body: "",
      javascript: "",
    };
    const parsed = parseManagedSections(composeManagedDocument(sections));
    expect(parsed).toEqual(sections);
  });

  it("returns null for a non-managed document", () => {
    expect(parseManagedSections("<html><body>hi</body></html>")).toBeNull();
    expect(isManagedDocument("<!doctype html><p>x</p>")).toBe(false);
  });

  it("returns null when an owned node is duplicated", () => {
    const html = base().replace(
      "</body>",
      '<main id="app" data-archestra-app-body>dup</main></body>',
    );
    expect(parseManagedSections(html)).toBeNull();
  });

  it("returns null when an owned node is in the wrong parent", () => {
    // A <style> is valid in <body>, so parse5 leaves it there (unlike a <main>
    // in <head>, which the tree-construction algorithm relocates to <body>);
    // its parent is then <body>, not the required <head>.
    const html =
      "<!doctype html><html><head><title data-archestra-app-title>t</title></head>" +
      "<body><style data-archestra-app-css></style>" +
      '<main id="app" data-archestra-app-body>x</main>' +
      "<script data-archestra-app-script></script></body></html>";
    expect(parseManagedSections(html)).toBeNull();
  });

  it('requires id="app" on the owned body node', () => {
    // Stripping id="app" (which app CSS/JS targets) de-manages the document
    // rather than leaving a shell that claims managed but breaks #app.
    const html = base().replace(
      '<main id="app" data-archestra-app-body>',
      "<main data-archestra-app-body>",
    );
    expect(html).toContain("data-archestra-app-body");
    expect(isManagedDocument(html)).toBe(false);
  });

  it("recognizes owned attributes regardless of case", () => {
    // HTML attribute names are case-insensitive; the fast-path must agree with
    // parse5's normalization rather than report an uppercased shell as raw.
    const upper = base()
      .replace(/data-archestra-app-title/g, "DATA-ARCHESTRA-APP-TITLE")
      .replace(/data-archestra-app-css/g, "DATA-ARCHESTRA-APP-CSS")
      .replace(/data-archestra-app-body/g, "DATA-ARCHESTRA-APP-BODY")
      .replace(/data-archestra-app-script/g, "DATA-ARCHESTRA-APP-SCRIPT");
    expect(isManagedDocument(upper)).toBe(true);
    expect(parseManagedSections(upper)?.title).toBe(SAMPLE.title);
  });

  it("rejects section content that would break out of an owned node", () => {
    expect(() =>
      composeManagedDocument({ ...SAMPLE, css: "a{} </style> b" }),
    ).toThrow(ApiError);
    expect(() =>
      composeManagedDocument({ ...SAMPLE, javascript: 'x = "</script>";' }),
    ).toThrow(ApiError);
    expect(() =>
      composeManagedDocument({ ...SAMPLE, body: "</main> stray" }),
    ).toThrow(ApiError);
  });

  it("allows lookalike substrings that are not real close tags", () => {
    const sections: ManagedSections = {
      title: "t",
      css: "/* </scripture> is fine */",
      body: "<p>the </maintenance window</p>",
      javascript: "const s = '</styles-ok';",
    };
    expect(() => composeManagedDocument(sections)).not.toThrow();
  });
});

describe("applySectionMutations", () => {
  it("replaces a single section and reports it changed, leaving others intact", () => {
    const { html, changed } = applySectionMutations(base(), {
      body: { replace: "<h1>New</h1>" },
    });
    expect(changed).toEqual(["body"]);
    const parsed = parseManagedSections(html);
    expect(parsed?.body).toBe("<h1>New</h1>");
    expect(parsed?.css).toBe(SAMPLE.css);
    expect(parsed?.javascript).toBe(SAMPLE.javascript);
    expect(parsed?.title).toBe(SAMPLE.title);
  });

  it("applies a within-section str_replace patch without resending the section", () => {
    const { html, changed } = applySectionMutations(base(), {
      javascript: {
        patch: [{ old_str: "const x = 1;", new_str: "const x = 2;" }],
      },
    });
    expect(changed).toEqual(["javascript"]);
    expect(parseManagedSections(html)?.javascript).toBe(
      "await archestra.ready;\nconst x = 2;",
    );
  });

  it("reports no change and returns the base for a net-no-op mutation", () => {
    const result = applySectionMutations(base(), {
      body: { replace: SAMPLE.body },
    });
    expect(result.changed).toEqual([]);
    expect(result.html).toBe(base());
  });

  it("preserves out-of-band content added outside the owned nodes", () => {
    const withMeta = base().replace(
      "</head>",
      '<meta name="theme-color" content="#111"></head>',
    );
    const { html } = applySectionMutations(withMeta, {
      css: { replace: ".x{}" },
    });
    expect(html).toContain('<meta name="theme-color" content="#111">');
    expect(parseManagedSections(html)?.css).toBe(".x{}");
  });

  it("throws when the base is not a managed document", () => {
    const err = expectApiError(() =>
      applySectionMutations("<html><body>x</body></html>", {
        body: { replace: "y" },
      }),
    );
    expect(err.statusCode).toBe(400);
  });

  it("rejects a patch whose old_str does not match, before any splice", () => {
    const err = expectApiError(() =>
      applySectionMutations(base(), {
        css: { patch: [{ old_str: "not-present", new_str: "x" }] },
      }),
    );
    expect(err.statusCode).toBe(400);
  });

  it("rejects a replacement that breaks out of its node", () => {
    expect(() =>
      applySectionMutations(base(), {
        javascript: { replace: 'a = "</script><script>evil()</script>";' },
      }),
    ).toThrow(ApiError);
  });

  it("rejects a body that injects a duplicate owned node (via the round-trip backstop)", () => {
    expect(() =>
      applySectionMutations(base(), {
        body: { replace: "<main data-archestra-app-body>x</main>" },
      }),
    ).toThrow(ApiError);
  });

  it("rejects content that only breaks topology at the round-trip backstop", () => {
    // An unclosed comment passes every up-front delimiter check, but swallows
    // the owned close tags when parsed, so the re-parse fails and nothing saves.
    const err = expectApiError(() =>
      applySectionMutations(base(), { body: { replace: "<!--" } }),
    );
    expect(err.statusCode).toBe(400);
  });

  it("changes the title via replacement", () => {
    const { html, changed } = applySectionMutations(base(), {
      title: "Renamed",
    });
    expect(changed).toEqual(["title"]);
    expect(parseManagedSections(html)?.title).toBe("Renamed");
  });
});
