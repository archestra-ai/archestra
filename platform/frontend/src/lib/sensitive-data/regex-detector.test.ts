import { describe, expect, it } from "vitest";

import { regexDetector } from "./regex-detector";

const labels = (text: string): string[] =>
  regexDetector
    .scan(text, { existingFindings: [] })
    .map((f) => f.internalLabel);

describe("regexDetector positive cases", () => {
  it("detects an AWS access key", () => {
    expect(labels("here is AKIAIOSFODNN7EXAMPLE in text")).toContain(
      "aws-access-key",
    );
  });

  it("detects a GitHub personal access token", () => {
    const token = `ghp_${"a".repeat(36)}`;
    expect(labels(`token=${token}`)).toContain("github-token");
  });

  it("detects a GitHub Actions token (gha_)", () => {
    const token = `gha_${"a".repeat(36)}`;
    expect(labels(`token=${token}`)).toContain("github-token");
  });

  it("detects a GitHub fine-grained PAT (github_pat_)", () => {
    const token = `github_pat_${"a".repeat(22)}_${"b".repeat(59)}`;
    expect(labels(`token=${token}`)).toContain("github-fine-grained-pat");
  });

  it("detects an Anthropic key", () => {
    const key = `sk-ant-${"a".repeat(40)}`;
    expect(labels(`key: ${key}`)).toContain("anthropic-key");
  });

  it("detects an OpenAI key (legacy format)", () => {
    const key = `sk-${"A".repeat(40)}`;
    expect(labels(`key: ${key}`)).toContain("openai-key");
  });

  it("detects an OpenAI key (sk-proj- format)", () => {
    const key = `sk-proj-${"A".repeat(40)}`;
    expect(labels(`key: ${key}`)).toContain("openai-key");
  });

  it("detects a Slack token", () => {
    const token = `xoxb-${"0".repeat(10)}-${"a".repeat(15)}`;
    expect(labels(`slack=${token}`)).toContain("slack-token");
  });

  it("detects a Google API key", () => {
    const key = `AIza${"B".repeat(35)}`;
    expect(labels(`key=${key}`)).toContain("google-api-key");
  });

  it("detects a JWT", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    expect(labels(`auth: ${jwt}`)).toContain("jwt");
  });

  it("detects a PEM private key header", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----";
    expect(labels(`${pem}\nMIIE...`)).toContain("pem-private-key");
  });

  it("detects a generic password assignment", () => {
    expect(labels("password=hunter2")).toContain("password-assignment");
    expect(labels("password: hunter2")).toContain("password-assignment");
    expect(labels("Password = hunter2")).toContain("password-assignment");
  });
});

describe("regexDetector negative cases", () => {
  it("ignores ordinary prose", () => {
    expect(labels("The quick brown fox jumps over the lazy dog.")).toEqual([]);
  });

  it("ignores code without secrets", () => {
    expect(labels("function add(a, b) { return a + b; }")).toEqual([]);
  });

  it("does not flag AKIA without enough chars", () => {
    expect(labels("AKIA123")).toEqual([]);
  });

  it("does not flag bare 'password' without assignment", () => {
    expect(labels("my password is somewhere safe")).toEqual([]);
  });

  it("does not flag password assignment with value shorter than 4 chars", () => {
    expect(labels("password=abc")).toEqual([]);
    expect(labels("password: x")).toEqual([]);
  });

  it("does not flag short sk- prefix", () => {
    expect(labels("ask-me anything")).toEqual([]);
  });

  it("does not flag sk- embedded in a longer word (e.g. task-my-long-slug)", () => {
    // "task-my-very-long-slug-name" contains "sk-my-very-long-slug-name" starting at index 2
    expect(labels("task-my-very-long-slug-name-here-end")).toEqual([]);
  });
});

describe("regexDetector dedupe and ranges", () => {
  it("returns one finding per match position even when same rule re-matches", () => {
    const token1 = `ghp_${"a".repeat(36)}`;
    const token2 = `ghp_${"b".repeat(36)}`;
    const found = regexDetector.scan(`${token1} and ${token2}`, {
      existingFindings: [],
    });
    const githubFindings = found.filter(
      (f) => f.internalLabel === "github-token",
    );
    expect(githubFindings).toHaveLength(2);
    expect(githubFindings[0].startIndex).toBeLessThan(
      githubFindings[1].startIndex,
    );
  });

  it("reports correct start/end indices", () => {
    const text = "prefix AKIAIOSFODNN7EXAMPLE suffix";
    const found = regexDetector.scan(text, { existingFindings: [] });
    const aws = found.find((f) => f.internalLabel === "aws-access-key");
    expect(aws).toBeDefined();
    expect(text.slice(aws?.startIndex, aws?.endIndex)).toBe(
      "AKIAIOSFODNN7EXAMPLE",
    );
  });

  it("dedupes overlapping matches at the exact same range", () => {
    const text = "AKIAIOSFODNN7EXAMPLE";
    const first = regexDetector.scan(text, { existingFindings: [] });
    const second = regexDetector.scan(text, { existingFindings: [] });
    expect(first).toEqual(second);
    expect(
      first.filter((f) => f.startIndex === 0 && f.endIndex === text.length),
    ).toHaveLength(1);
  });
});
