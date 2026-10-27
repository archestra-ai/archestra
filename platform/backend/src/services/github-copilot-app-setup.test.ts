import { describe, expect, test } from "vitest";
import { parseGithubOrganization } from "@/services/github-copilot-app-setup";

describe("parseGithubOrganization", () => {
  test("reads a bare name as an organization on github.com", () => {
    expect(parseGithubOrganization(" my-org ")).toEqual({
      web: "https://github.com",
      api: "https://api.github.com",
      login: "my-org",
    });
  });

  test("reads a github.com address, ignoring a trailing slash or settings path", () => {
    const expected = {
      web: "https://github.com",
      api: "https://api.github.com",
      login: "my-org",
    };
    expect(parseGithubOrganization("https://github.com/my-org")).toEqual(
      expected,
    );
    expect(parseGithubOrganization("https://github.com/my-org/")).toEqual(
      expected,
    );
    expect(
      parseGithubOrganization("github.com/my-org/settings/copilot"),
    ).toEqual(expected);
  });

  test("reads a GitHub Enterprise Server address with a trailing path", () => {
    expect(
      parseGithubOrganization(
        "https://github.example.com/other-org/settings/apps",
      ),
    ).toEqual({
      web: "https://github.example.com",
      api: "https://github.example.com/api/v3",
      login: "other-org",
    });
  });

  test("reads a ghe.com address", () => {
    expect(
      parseGithubOrganization("https://my-company.ghe.com/my-org"),
    ).toEqual({
      web: "https://my-company.ghe.com",
      api: "https://api.my-company.ghe.com",
      login: "my-org",
    });
  });

  test.each([
    "",
    "not an org",
    "https://github.com",
    "https://github.com/-bad-",
    "ftp://github.com/my-org",
  ])("refuses %j with a message that says what to enter", (input) => {
    expect(() => parseGithubOrganization(input)).toThrow(
      "Enter an organization name or its GitHub address.",
    );
  });
});
