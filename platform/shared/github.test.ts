import { describe, expect, it } from "vitest";
import { parseGithubAccountInput } from "./github";

describe("parseGithubAccountInput", () => {
  it("reads a bare name as an account on github.com", () => {
    expect(parseGithubAccountInput(" my-org ")).toEqual({
      web: "https://github.com",
      api: "https://api.github.com",
      login: "my-org",
      dotCom: true,
    });
  });

  it("reads a github.com address, ignoring a trailing slash or settings path", () => {
    const expected = {
      web: "https://github.com",
      api: "https://api.github.com",
      login: "my-org",
      dotCom: true,
    };
    expect(parseGithubAccountInput("https://github.com/my-org")).toEqual(
      expected,
    );
    expect(parseGithubAccountInput("https://github.com/my-org/")).toEqual(
      expected,
    );
    expect(
      parseGithubAccountInput("github.com/my-org/settings/copilot"),
    ).toEqual(expected);
  });

  it("reads a GitHub Enterprise Server address with a trailing path", () => {
    expect(
      parseGithubAccountInput("https://github.example.com/other-org/settings"),
    ).toEqual({
      web: "https://github.example.com",
      api: "https://github.example.com/api/v3",
      login: "other-org",
      dotCom: false,
    });
  });

  it("reads a ghe.com address", () => {
    expect(
      parseGithubAccountInput("https://my-company.ghe.com/my-org"),
    ).toEqual({
      web: "https://my-company.ghe.com",
      api: "https://api.my-company.ghe.com",
      login: "my-org",
      dotCom: false,
    });
  });

  it.each([
    "",
    "not an org",
    "https://github.com",
    "https://github.com/-bad-",
    "ftp://github.com/my-org",
  ])("names no account for %j", (input) => {
    expect(parseGithubAccountInput(input)).toBeNull();
  });
});
