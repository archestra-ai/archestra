import { describe, expect, test } from "vitest";
import type { GuardrailsPolicyEdit } from "@/types/guardrails-policy-proposal";
import {
  policyDiff,
  resolveProposedPolicy,
} from "./guardrails-policy-proposal";

function applyPolicyEdits(params: {
  text: string;
  revision: number;
  edits: GuardrailsPolicyEdit[];
}) {
  return resolveProposedPolicy({
    current: { revision: params.revision, content: params.text },
    proposal: { edits: params.edits },
  });
}

const POLICY = `[policy]
version = 2

[[policy.tool]]
name = "github__get_issue"
delta = {}

# Catch-all
[[policy.tool]]
name = "*"
annotator = "noop"
`;

const RULE = `[[policy.tool]]
name = "github__create_issue"
delta = {}

`;

describe("applyPolicyEdits", () => {
  test("inserting before an anchor line keeps every other byte", () => {
    const after = applyPolicyEdits({
      text: POLICY,
      revision: 4,
      edits: [{ oldText: "# Catch-all\n", newText: `${RULE}# Catch-all\n` }],
    });
    expect(after).toBe(POLICY.replace("# Catch-all\n", `${RULE}# Catch-all\n`));
  });

  test("each edit applies to the result of the one before", () => {
    const after = applyPolicyEdits({
      text: "a\nb\n",
      revision: 1,
      edits: [
        { oldText: "a\n", newText: "a\nc\n" },
        { oldText: "c\nb\n", newText: "d\n" },
      ],
    });
    expect(after).toBe("a\nd\n");
  });

  test("newText is inserted literally, without replacement patterns", () => {
    expect(
      applyPolicyEdits({
        text: "x = 1\n",
        revision: 1,
        edits: [{ oldText: "1", newText: '"$&$\'$$"' }],
      }),
    ).toBe('x = "$&$\'$$"\n');
  });

  test("replaceAll replaces every match; without it a repeat is refused", () => {
    const edit = { oldText: "delta = {}", newText: 'delta = { trust = "x" }' };
    const twice = `${POLICY}${RULE}`;
    expect(() =>
      applyPolicyEdits({ text: twice, revision: 7, edits: [edit] }),
    ).toThrow(
      "edits[0]: oldText matches 2 places. Add surrounding lines to make it unique, or set replaceAll to true.",
    );
    const after = applyPolicyEdits({
      text: twice,
      revision: 7,
      edits: [{ ...edit, replaceAll: true }],
    });
    expect(after).not.toContain("delta = {}");
    expect(after.split('delta = { trust = "x" }')).toHaveLength(3);
  });

  test("a missing oldText names the edit and the revision", () => {
    expect(() =>
      applyPolicyEdits({
        text: POLICY,
        revision: 28,
        edits: [{ oldText: "version = 3", newText: "version = 2" }],
      }),
    ).toThrow(
      "edits[0]: oldText was not found in the policy at revision 28. Copy the exact text from get_guardrails_policy, including whitespace.",
    );
    expect(() =>
      applyPolicyEdits({
        text: POLICY,
        revision: 28,
        edits: [
          { oldText: "# Catch-all", newText: "# Fallback" },
          { oldText: "# Catch-all", newText: "# Default" },
        ],
      }),
    ).toThrow(
      "edits[1]: oldText was not found in the policy at revision 28 after the earlier edits.",
    );
  });

  test("an edit that changes nothing, or has no oldText, is refused", () => {
    expect(() =>
      applyPolicyEdits({
        text: POLICY,
        revision: 1,
        edits: [{ oldText: "version = 2", newText: "version = 2" }],
      }),
    ).toThrow(
      "edits[0]: oldText and newText are the same. Remove this edit or change newText.",
    );
    expect(() =>
      applyPolicyEdits({
        text: POLICY,
        revision: 1,
        edits: [{ oldText: "", newText: "x" }],
      }),
    ).toThrow("edits[0]: oldText is empty.");
  });

  test("the result keeps the content bounds", () => {
    expect(() =>
      applyPolicyEdits({
        text: POLICY,
        revision: 1,
        edits: [{ oldText: POLICY, newText: "" }],
      }),
    ).toThrow("The edits leave the policy empty.");
    expect(() =>
      applyPolicyEdits({
        text: POLICY,
        revision: 1,
        edits: [{ oldText: "# Catch-all", newText: "#".repeat(262144) }],
      }),
    ).toThrow(/over the 262144 limit/);
  });
});

describe("resolveProposedPolicy", () => {
  const current = { revision: 3, content: POLICY };
  const edits = [{ oldText: "version = 2", newText: "version = 2 # v2" }];

  test("content is the proposed policy as sent", () => {
    expect(
      resolveProposedPolicy({ current, proposal: { content: "new\n" } }),
    ).toBe("new\n");
  });

  test("strict-mode filler counts as absent", () => {
    const edited = POLICY.replace("version = 2", "version = 2 # v2");
    for (const content of ["", null, undefined])
      expect(
        resolveProposedPolicy({ current, proposal: { content, edits } }),
      ).toBe(edited);
    for (const empty of [[], null, undefined])
      expect(
        resolveProposedPolicy({
          current,
          proposal: { content: "full\n", edits: empty },
        }),
      ).toBe("full\n");
  });

  test("both or neither is refused with what to send", () => {
    expect(() =>
      resolveProposedPolicy({ current, proposal: { content: "x", edits } }),
    ).toThrow(
      "Send either edits or content, not both. Use edits to change the current policy, or content for a first policy or a full rewrite.",
    );
    expect(() =>
      resolveProposedPolicy({ current, proposal: { content: "", edits: [] } }),
    ).toThrow(
      "Send edits to change the current policy, or content with the complete policy text.",
    );
  });
});

describe("policyDiff", () => {
  const lines = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => `l${from + i}\n`).join("");

  test("no change is an empty diff", () => {
    expect(policyDiff({ before: POLICY, after: POLICY, path: "p" })).toEqual({
      diff: "",
      changed: { added: 0, removed: 0 },
    });
  });

  test("a change inside a long document shows only it and 3 lines of context", () => {
    const before = lines(1, 20);
    const after = before.replace("l10\n", "ten\n");
    expect(policyDiff({ before, after, path: "org.toml" })).toEqual({
      diff: [
        "--- a/org.toml",
        "+++ b/org.toml",
        "@@ -7,7 +7,7 @@",
        " l7",
        " l8",
        " l9",
        "-l10",
        "+ten",
        " l11",
        " l12",
        " l13",
        "",
      ].join("\n"),
      changed: { added: 1, removed: 1 },
    });
  });

  test("distant changes get separate hunks; close ones share one", () => {
    const before = lines(1, 30);
    const distant = before.replace("l3\n", "x\n").replace("l25\n", "y\n");
    expect(
      policyDiff({ before, after: distant, path: "p" }).diff.match(/^@@/gm),
    ).toEqual(["@@", "@@"]);
    expect(policyDiff({ before, after: distant, path: "p" }).diff).toContain(
      "@@ -22,7 +22,7 @@",
    );
    const close = before.replace("l10\n", "x\n").replace("l16\n", "y\n");
    expect(policyDiff({ before, after: close, path: "p" }).diff).toContain(
      "@@ -7,13 +7,13 @@",
    );
  });

  test("insertion at the start and at the end", () => {
    const before = lines(1, 5);
    expect(
      policyDiff({ before, after: `new\n${before}`, path: "p" }).diff,
    ).toBe("--- a/p\n+++ b/p\n@@ -1,3 +1,4 @@\n+new\n l1\n l2\n l3\n");
    expect(policyDiff({ before, after: `${before}new\n`, path: "p" })).toEqual({
      diff: "--- a/p\n+++ b/p\n@@ -3,3 +3,4 @@\n l3\n l4\n l5\n+new\n",
      changed: { added: 1, removed: 0 },
    });
    expect(policyDiff({ before: "", after: "a\nb\n", path: "p" }).diff).toBe(
      "--- a/p\n+++ b/p\n@@ -0,0 +1,2 @@\n+a\n+b\n",
    );
  });

  test("a missing final newline is marked and counts as a change", () => {
    expect(policyDiff({ before: "a\nb\n", after: "a\nb", path: "p" })).toEqual({
      diff: "--- a/p\n+++ b/p\n@@ -1,2 +1,2 @@\n a\n-b\n+b\n\\ No newline at end of file\n",
      changed: { added: 1, removed: 1 },
    });
  });

  test("a middle too large for the LCS table becomes one replacement hunk", () => {
    const before = `head\n${lines(1, 2500)}tail\n`;
    const after = `head\n${lines(1, 2500).replaceAll("l", "m")}tail\n`;
    const { diff, changed } = policyDiff({ before, after, path: "p" });
    expect(changed).toEqual({ added: 2500, removed: 2500 });
    expect(diff.match(/^@@.*$/gm)).toEqual(["@@ -1,2502 +1,2502 @@"]);
    expect(applyUnifiedDiff(before, diff)).toBe(after);
  });

  test("a policy at the size limit diffs and applies back", () => {
    const before = "x = 1\n".repeat(262144 / 6);
    const after = `${before.slice(0, 600)}y = 2\n${before.slice(600, -6)}`;
    const { diff, changed } = policyDiff({ before, after, path: "p" });
    expect(changed).toEqual({ added: 1, removed: 1 });
    expect(applyUnifiedDiff(before, diff)).toBe(after);
  });

  test("random edits always produce a diff that applies back exactly", () => {
    let seed = 42;
    const random = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    const doc = (n: number) => {
      const text = Array.from(
        { length: n },
        () => `${"abcde"[Math.floor(random() * 5)]}\n`,
      ).join("");
      return random() < 0.3 ? text.slice(0, -1) : text;
    };
    for (let run = 0; run < 300; run++) {
      const before = doc(Math.floor(random() * 40));
      const after = doc(Math.floor(random() * 40));
      const { diff, changed } = policyDiff({ before, after, path: "p" });
      expect(applyUnifiedDiff(before, diff)).toBe(after);
      expect(diff.match(/^\+(?!\+\+ )/gm)?.length ?? 0).toBe(changed.added);
      expect(diff.match(/^-(?!-- )/gm)?.length ?? 0).toBe(changed.removed);
    }
  });
});

/** Applies a unified diff strictly: context, removals and hunk headers must all agree. */
function applyUnifiedDiff(before: string, diff: string): string {
  if (diff === "") return before;
  const old = before.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const lines = diff.split("\n");
  expect(lines.slice(0, 2)).toEqual(["--- a/p", "+++ b/p"]);
  const out: string[] = [];
  let pos = 0;
  let k = 2;
  while (k < lines.length - 1) {
    const header = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/.exec(lines[k++]);
    if (!header) throw new Error(`bad hunk header ${lines[k - 1]}`);
    const [oldStart, oldCount, newStart, newCount] = header
      .slice(1)
      .map(Number);
    const start = oldCount === 0 ? oldStart : oldStart - 1;
    expect(start).toBeGreaterThanOrEqual(pos);
    out.push(...old.slice(pos, start));
    pos = start;
    expect(newCount === 0 ? newStart : newStart - 1).toBe(out.length);
    let seenOld = 0;
    let seenNew = 0;
    while (k < lines.length - 1 && !lines[k].startsWith("@@")) {
      const kind = lines[k][0];
      let text = `${lines[k++].slice(1)}\n`;
      if (lines[k] === "\\ No newline at end of file") {
        text = text.slice(0, -1);
        k++;
      }
      if (kind !== "+") {
        expect(old[pos++]).toBe(text);
        seenOld++;
      }
      if (kind !== "-") {
        out.push(text);
        seenNew++;
      }
    }
    expect([seenOld, seenNew]).toEqual([oldCount, newCount]);
  }
  out.push(...old.slice(pos));
  return out.join("");
}
