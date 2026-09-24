import { describe, expect, test } from "vitest";
import { type SetupRule, withSetupRule } from "./setup-rule";

const BASE = "[policy]\nversion = 2\n";

describe("withSetupRule", () => {
  test("a flow rule lowers trust at the source and requires it at the guarded tool", () => {
    const { content } = withSetupRule(BASE, {
      shape: "flow",
      source: "github__issue_read",
      guarded: "slack__post_message",
    });
    expect(content).toContain(
      '[[policy.tool]]\nname = "github__issue_read"\ndelta = { trust = "suspicious" }',
    );
    expect(content).toContain(
      '[[policy.tool]]\nname = "slack__post_message"\ntags = ["setup-review"]\ndelta = {}\nrequires = { trust = "trusted" }',
    );
  });

  test("a single-tool rule requires the reviewer's mark", () => {
    const { content } = withSetupRule(BASE, {
      shape: "tool",
      guarded: "archestra__edit_file",
    });
    expect(content).toContain(
      'name = "archestra__edit_file"\ntags = ["setup-review"]\ndelta = {}\nrequires = { attention = ["setup-review"] }',
    );
  });

  test("an audience rule narrows readers at the source and requires public at the guarded tool", () => {
    const { content } = withSetupRule(BASE, {
      shape: "audience",
      source: "crm__get_customer",
      guarded: "github__create_issue",
    });
    expect(content).toContain(
      'name = "crm__get_customer"\ndelta = { audience = ["internal"] }',
    );
    expect(content).toContain(
      'name = "github__create_issue"\ntags = ["setup-review"]\ndelta = {}\nrequires = { audience = { contains = ["public"] } }',
    );
    expect(content).toContain('audience_missing = ["public"]');
  });

  test("a repeat rule excludes its own effect and declares a reviewer for it", () => {
    const { content } = withSetupRule(BASE, {
      shape: "repeat",
      guarded: "gmail__send_email",
    });
    expect(content).toContain(
      'effects = ["setup.gmail__send_email.ran"]\nrequires = { effects = { excludes = ["setup.gmail__send_email.ran"] } }',
    );
    expect(content).toContain(
      '[externals.authorities.setup-repeat-gmail__send_email]\nbuiltin = "hitl"',
    );
    expect(content).toContain(
      'permits = { effects_containing = ["setup.gmail__send_email.ran"] }',
    );
    expect(content).not.toContain("[externals.authorities.setup-reviewer]");
  });

  test("declares the reviewer once", () => {
    const { content: once } = withSetupRule(BASE, {
      shape: "tool",
      guarded: "archestra__edit_file",
    });
    expect(once).toContain(
      'permits = { trust_below = "trusted", audience_missing = ["public"], attention = ["setup-review"] }',
    );
    const { content: twice } = withSetupRule(once, {
      shape: "flow",
      source: "github__issue_read",
      guarded: "slack__post_message",
    });
    expect(
      twice.match(/\[externals\.authorities\.setup-reviewer\]/g),
    ).toHaveLength(1);
  });

  test("reports the lines the rule takes", () => {
    const { content, added } = withSetupRule(BASE, {
      shape: "tool",
      guarded: "archestra__edit_file",
    });
    const lines = content.split("\n");
    expect(lines[added.from - 1]).toBe("# Added by OpenAPPA setup.");
    expect(lines[added.to - 1]).toBe('builtin = "hitl"');
    expect(lines.slice(added.to).join("")).toBe("");
  });

  test.each<SetupRule>([
    {
      shape: "flow",
      source: "github__issue_read",
      guarded: "slack__post_message",
    },
    {
      shape: "audience",
      source: "crm__get_customer",
      guarded: "github__create_issue",
    },
    { shape: "tool", guarded: "archestra__edit_file" },
    { shape: "repeat", guarded: "gmail__send_email" },
  ])("does not append an already saved $shape rule", (rule) => {
    const first = withSetupRule(BASE, rule);
    const retried = withSetupRule(first.content, rule);

    expect(retried.content).toBe(first.content);
    const lines = retried.content.split("\n");
    expect(lines[retried.added.from - 1]).toBe("# Added by OpenAPPA setup.");
    expect(lines[retried.added.to - 1]).toBe('builtin = "hitl"');
  });

  test("still appends a different rule for the same tool", () => {
    const first = withSetupRule(BASE, {
      shape: "flow",
      source: "github__issue_read",
      guarded: "slack__post_message",
    });
    const second = withSetupRule(first.content, {
      shape: "flow",
      source: "github__issue_search",
      guarded: "slack__post_message",
    });

    expect(second.content).not.toBe(first.content);
    expect(second.content.match(/# Added by OpenAPPA setup\./g)).toHaveLength(
      2,
    );
    expect(second.content.split("\n")[second.added.from - 1]).toBe(
      "# Added by OpenAPPA setup.",
    );
  });

  test("reuses a saved rule whose reviewer was declared by an earlier rule", () => {
    const first = withSetupRule(BASE, {
      shape: "tool",
      guarded: "archestra__edit_file",
    });
    const rule: SetupRule = {
      shape: "flow",
      source: "github__issue_read",
      guarded: "slack__post_message",
    };
    const second = withSetupRule(first.content, rule);
    const retried = withSetupRule(second.content, rule);

    expect(retried.content).toBe(second.content);
    const lines = retried.content.split("\n");
    expect(lines[retried.added.from - 1]).toBe("# Added by OpenAPPA setup.");
    expect(lines[retried.added.to - 1]).toBe(
      'requires = { trust = "trusted" }',
    );
  });
});
