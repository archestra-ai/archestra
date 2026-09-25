// @vitest-environment node
import { describe, expect, it } from "vitest";
import { getRepositoryDisplay } from "./repository-display";

describe("getRepositoryDisplay", () => {
  it.each([
    "acme/skills",
    "github.com/acme/skills",
    "https://github.com/acme/skills.git/",
    "https://github.com/acme/skills/tree/main/pdf",
  ])("preserves public repository labels and avatars for %s", (repository) => {
    expect(getRepositoryDisplay(repository)).toEqual({
      owner: "acme",
      label: "acme/skills",
      avatarUrl: "https://github.com/acme.png",
    });
  });

  it.each([
    "git.example.com",
    "github.com.example.com",
    "git.example.com:8443",
  ])("includes %s in the label without requesting a public avatar", (host) => {
    expect(
      getRepositoryDisplay(`https://${host}/acme/skills.git/tree/main`),
    ).toEqual({
      owner: "acme",
      label: `${host}/acme/skills`,
      avatarUrl: undefined,
    });
  });

  it.each([
    "acme/skills",
    "git.example.com/acme/skills",
    "https://git.example.com/acme/skills",
  ])("resolves Enterprise input %s against its App host", (repository) => {
    expect(
      getRepositoryDisplay(repository, "https://git.example.com/api/v3"),
    ).toEqual({
      owner: "acme",
      label: "git.example.com/acme/skills",
      avatarUrl: undefined,
    });
  });

  it("resolves Enterprise Cloud shorthand against the repository host", () => {
    expect(
      getRepositoryDisplay("acme/skills", "https://api.acme.ghe.com"),
    ).toEqual({
      owner: "acme",
      label: "acme.ghe.com/acme/skills",
      avatarUrl: undefined,
    });
  });
});
