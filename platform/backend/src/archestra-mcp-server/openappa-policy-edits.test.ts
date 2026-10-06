import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import config from "@/config";
import GuardrailsPolicyModel from "@/models/guardrails-policy";
import {
  guardrailsPolicyService,
  initialPolicy,
} from "@/services/guardrails-policy";
import { beforeEach, describe, expect, test } from "@/test";
import { type ArchestraContext, executeArchestraTool } from ".";

const ANCHOR =
  "# Tools without a specific rule have no additional restrictions.\n";

function rules(names: string[]): string {
  return names
    .map((name) => `[[policy.tool]]\nname = "${name}"\ndelta = {}\n\n`)
    .join("");
}

function withRules(names: string[]): string {
  return initialPolicy().replace(ANCHOR, `${rules(names)}${ANCHOR}`);
}

const NEW_RULES = rules(["github__create_issue", "github__add_comment"]);
const INSERT = [{ oldText: ANCHOR, newText: `${NEW_RULES}${ANCHOR}` }];

let context: ArchestraContext;
let organizationId: string;
let userId: string;

beforeEach(
  async ({
    makeOrganization,
    makeUser,
    makeMember,
    makeAgent,
    seedAndAssignArchestraTools,
  }) => {
    config.openappa.enabled = true;
    const org = await makeOrganization();
    const user = await makeUser();
    await makeMember(user.id, org.id, { role: "admin" });
    const agent = await makeAgent({ organizationId: org.id });
    await seedAndAssignArchestraTools(agent.id);
    organizationId = org.id;
    userId = user.id;
    context = {
      agent: { id: agent.id, name: agent.name },
      organizationId,
      userId,
    };
  },
);

async function saveRevision(content: string) {
  const { revision } = await guardrailsPolicyService.get(organizationId);
  return guardrailsPolicyService.update({
    organizationId,
    userId,
    content,
    expectedRevision: revision,
  });
}

function preview(args: Record<string, unknown>) {
  return executeArchestraTool(
    "archestra__preview_guardrails_policy_change",
    args,
    context,
  );
}

function publish(args: Record<string, unknown>) {
  return executeArchestraTool(
    "archestra__update_guardrails_policy",
    { title: "Add GitHub rules", summary: "Two write rules", ...args },
    context,
  );
}

/** What the chat model reads: the text block, not structuredContent. */
function modelText(
  result: CallToolResult,
): Record<string, unknown> & { diff: string } {
  expect(result.isError).toBeFalsy();
  const [block] = result.content;
  if (block?.type !== "text") throw new Error("Expected a text block");
  return JSON.parse(block.text);
}

function errorText(result: CallToolResult): string {
  expect(result.isError).toBe(true);
  const [block] = result.content;
  return block?.type === "text" ? block.text : "";
}

describe("policy edits", () => {
  test("preview applies only the insertion and gives the model a diff instead of both texts; publish saves the same text", async () => {
    const current = withRules(["github__get_issue", "github__list_issues"]);
    await saveRevision(current);

    const previewed = await preview({ edits: INSERT, expectedRevision: 1 });
    const after = (previewed.structuredContent as { after: string }).after;
    expect(after).toBe(current.replace(ANCHOR, `${NEW_RULES}${ANCHOR}`));
    expect((previewed.structuredContent as { before: string }).before).toBe(
      current,
    );

    const seen = modelText(previewed);
    expect(seen).not.toHaveProperty("before");
    expect(seen).not.toHaveProperty("after");
    expect(seen).toMatchObject({
      stage: "preview",
      valid: true,
      changed: { added: 8, removed: 0 },
    });
    expect(seen.diff).toContain("+++ b/organization.appa.toml\n");
    expect(seen.diff).toContain('+name = "github__create_issue"\n');
    expect(seen.diff).toContain('+name = "github__add_comment"\n');
    expect(seen.diff.match(/^@@/gm)).toHaveLength(1);
    expect(seen.diff).not.toContain("github__get_issue");

    const published = await publish({ edits: INSERT, expectedRevision: 1 });
    const saved = await GuardrailsPolicyModel.findLatest(organizationId);
    expect(saved).toMatchObject({ revision: 2, content: after });
    const publishedText = modelText(published);
    expect(publishedText).not.toHaveProperty("after");
    expect(publishedText).toMatchObject({
      delivery: "revision",
      revision: 2,
      diff: seen.diff,
      changed: { added: 8, removed: 0 },
    });
    expect((published.structuredContent as { after: string }).after).toBe(
      after,
    );
  });

  test("a two-rule preview of a 1,000-rule policy stays small for the model", async () => {
    const current = withRules(
      Array.from({ length: 1000 }, (_, i) => `github__tool_${i}`),
    );
    await saveRevision(current);
    expect(current.length).toBeGreaterThan(50_000);

    const previewed = await preview({ edits: INSERT, expectedRevision: 1 });
    const [block] = previewed.content;
    expect(block?.type === "text" && block.text.length).toBeLessThan(2_000);
  });

  test("a stale revision is a conflict even when its edits no longer match", async () => {
    await saveRevision(withRules(["github__get_issue"]));
    const edits = [{ oldText: "not in the policy", newText: "x" }];
    for (const call of [preview, publish])
      expect(errorText(await call({ edits, expectedRevision: 0 }))).toContain(
        "The policy changed. Read it again",
      );
  });

  test("refused edits explain the fix and save nothing", async () => {
    await saveRevision(withRules(["github__get_issue", "github__list_issues"]));
    const cases: Array<[Record<string, unknown>, string]> = [
      [
        { edits: [{ oldText: "github__missing", newText: "x" }] },
        "edits[0]: oldText was not found in the policy at revision 1. Copy the exact text from get_guardrails_policy, including whitespace.",
      ],
      [
        { edits: [{ oldText: "delta = {}", newText: "delta = { }" }] },
        "edits[0]: oldText matches 3 places. Add surrounding lines to make it unique, or set replaceAll to true.",
      ],
      [
        { edits: [{ oldText: "version = 2", newText: "version = 2" }] },
        "edits[0]: oldText and newText are the same. Remove this edit or change newText.",
      ],
      [
        { content: initialPolicy(), edits: INSERT },
        "Send either edits or content, not both.",
      ],
      [
        {},
        "Send edits to change the current policy, or content with the complete policy text.",
      ],
    ];
    for (const [args, message] of cases)
      for (const call of [preview, publish])
        expect(
          errorText(await call({ ...args, expectedRevision: 1 })),
        ).toContain(message);
    expect(
      (await GuardrailsPolicyModel.findLatest(organizationId))?.revision,
    ).toBe(1);
  });

  test("replaceAll changes every match", async () => {
    const current = withRules(["github__get_issue", "github__list_issues"]);
    await saveRevision(current);
    const previewed = await preview({
      edits: [
        {
          oldText: 'name = "github__',
          newText: 'name = "gh__',
          replaceAll: true,
        },
      ],
      expectedRevision: 1,
    });
    expect(modelText(previewed).changed).toEqual({ added: 2, removed: 2 });
    expect((previewed.structuredContent as { after: string }).after).toBe(
      current.replaceAll('name = "github__', 'name = "gh__'),
    );
  });

  test("strict-mode filler for the unused field is accepted", async () => {
    const current = withRules(["github__get_issue"]);
    await saveRevision(current);
    const edited = current.replace(ANCHOR, `${NEW_RULES}${ANCHOR}`);
    const fillers: Array<Record<string, unknown>> = [
      { content: "", edits: INSERT },
      { content: null, edits: [{ ...INSERT[0], replaceAll: null }] },
      { content: edited, edits: [] },
      { content: edited, edits: null },
    ];
    for (const args of fillers) {
      const previewed = await preview({ ...args, expectedRevision: 1 });
      expect(modelText(previewed).changed).toEqual({ added: 8, removed: 0 });
      expect((previewed.structuredContent as { after: string }).after).toBe(
        edited,
      );
    }
  });

  test("content still replaces the whole policy and returns a diff", async () => {
    const content = withRules(["github__get_issue"]);
    const previewed = await preview({ content, expectedRevision: 0 });
    const seen = modelText(previewed);
    expect(seen).not.toHaveProperty("after");
    expect(seen.changed).toEqual({ added: 4, removed: 0 });
    expect(seen.diff).toContain('+name = "github__get_issue"\n');

    await publish({ content, expectedRevision: 0 });
    expect(
      await GuardrailsPolicyModel.findLatest(organizationId),
    ).toMatchObject({ revision: 1, content });
  });
});
