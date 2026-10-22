import { describe, expect, test } from "vitest";
import { slackTaskText, toolArgumentsDetail } from "./slack-task-details";

describe("Slack task display redaction", () => {
  test("keeps useful nested arguments while removing credential fields and secret entries", () => {
    const input = {
      title: "Example task",
      options: {
        priority: "high",
        apiKey: "fixture-api-key",
        auth: { username: "user", password: "fixture-password" },
      },
      environment: [
        { name: "EXAMPLE", type: "secret", value: "fixture-env-secret" },
      ],
    };
    const original = structuredClone(input);
    const detail = toolArgumentsDetail(input);
    expect(detail).toContain("Example task");
    expect(detail).toContain("high");
    expect(detail).toContain("[redacted]");
    expect(detail).not.toContain("fixture-");
    expect(input).toEqual(original);
  });

  test.each([
    "access_token",
    "refreshToken",
    "Authorization",
    "AUTH",
    "Cookie",
    "headers",
    "client_secret",
    "private-key",
    "password",
    "runtime_proof",
    "api-key",
  ])("redacts %s at any nested level", (key) => {
    const detail = toolArgumentsDetail({
      config: { [key]: "fixture-credential" },
    });
    expect(detail).toContain("[redacted]");
    expect(detail).not.toContain("fixture-credential");
  });

  test("redacts name/value pairs and JSON strings with nested secrets", () => {
    const detail = toolArgumentsDetail({
      entries: [{ name: "X_API_KEY", value: "fixture-named-secret" }],
      config: '{"password":"fixture-json-secret"}',
    });
    expect(detail).not.toContain("fixture-");
    expect(detail).toContain("[redacted]");
  });

  test.each([
    "403: Authorization: Bearer fixture-credential",
    "403: password=fixture-credential with spaces",
    "403: api_key='fixture-credential with spaces'",
    "403: curl --password fixture-credential",
    "403: https://user:fixture-credential@example.test/path?token=fixture-credential",
    '403: headers={"x-custom":"fixture-credential"}',
    '{"code":403,"headers":{"custom":"fixture-credential"}}',
  ])("keeps error context without credential material: %s", (error) => {
    const result = slackTaskText(error);
    expect(result).toContain("403");
    expect(result).not.toContain("fixture-credential");
    expect(result).toContain("[redacted");
  });

  test("removes known token shapes and private keys from free text", () => {
    for (const credential of [
      "xoxb-fixture-credential",
      "sk-fixture-credential",
      "ghp_fixture-credential",
      "eyFixturePart.eyFixturePart.eyFixturePart",
      "-----BEGIN PRIVATE KEY-----\nfixture-credential\n-----END PRIVATE KEY-----",
    ]) {
      expect(slackTaskText(`Failed: ${credential}`)).toBe("Failed: [redacted]");
    }
  });

  test("bounds large, wide, deep and cyclic inputs while retaining an initial useful field", () => {
    const deep = {
      child: { child: { child: { child: { password: "fixture-secret" } } } },
    };
    const cyclic: Record<string, unknown> = { title: "Example task" };
    cyclic.self = cyclic;
    const cases = [
      { title: "Example task", huge: "x".repeat(1_000_000) },
      {
        title: "Example task",
        values: Array.from({ length: 10_000 }, (_, i) => ({ i })),
      },
      { title: "Example task", deep },
      {
        title: "Example task",
        ...Object.fromEntries(
          Array.from({ length: 10_000 }, (_, i) => [`field${i}`, i]),
        ),
      },
      cyclic,
    ];
    for (const input of cases) {
      const detail = toolArgumentsDetail(input) ?? "";
      expect(detail).toContain("Example task");
      expect(detail.length).toBeLessThanOrEqual(256);
      expect(detail).toMatch(/truncated|…/);
      expect(detail).not.toContain("fixture-secret");
    }
    expect(slackTaskText("x".repeat(1_000_000))).toBe("[truncated]");
  });

  test("does not invoke getters or serialization hooks", () => {
    const input = {
      title: "Example task",
      get privateData() {
        throw new Error("must not run");
      },
      toJSON() {
        throw new Error("must not run");
      },
    };
    expect(toolArgumentsDetail(input)).toContain("[truncated]");
  });

  test("neutralizes Slack mentions/links and caps the encoded text", () => {
    expect(
      toolArgumentsDetail({
        title: "<!channel> <@U123> & <https://example.test|go>",
      }),
    ).not.toMatch(/<|<!channel>/);
    expect(slackTaskText("<&".repeat(300)).length).toBeLessThanOrEqual(256);
    expect(toolArgumentsDetail({})).toBeUndefined();
  });

  test("preserves ordinary long tool names and truncates Unicode safely", () => {
    const toolName = "example__find_tasks_assigned_to_current_user";
    expect(slackTaskText(toolName)).toBe(toolName);
    const detail = toolArgumentsDetail({ title: "😀".repeat(150) }) ?? "";
    expect(detail).toContain("…");
    expect(Buffer.from(detail).toString("utf8")).toBe(detail);
    expect(detail.length).toBeLessThanOrEqual(256);
  });
});
