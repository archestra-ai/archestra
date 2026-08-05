import { describe, expect, it } from "vitest";
import {
  githubSourceUrlAtCommit,
  parseRepoFromSourceRef,
} from "./skill-source";

const COMMIT = "6500e3659dd2a3ceeb745b03eb6ab2d169d4e1e7";

describe("parseRepoFromSourceRef", () => {
  it("reads the repo out of a packed provenance string", () => {
    expect(parseRepoFromSourceRef("eph5xx/tiebreaker@main:skills/tiebreaker")) //
      .toBe("eph5xx/tiebreaker");
  });

  it("ignores the internal ref built-in skills carry", () => {
    expect(parseRepoFromSourceRef("builtin:archestra-platform-operations")) //
      .toBeNull();
    expect(parseRepoFromSourceRef(null)).toBeNull();
  });
});

describe("githubSourceUrlAtCommit", () => {
  it("links the skill directory at the commit the version was pulled from", () => {
    expect(
      githubSourceUrlAtCommit({
        sourceRef: "eph5xx/tiebreaker@main:skills/tiebreaker",
        commit: COMMIT,
      }),
    ).toBe(
      `https://github.com/eph5xx/tiebreaker/tree/${COMMIT}/skills/tiebreaker`,
    );
  });

  it("links the repo root for a skill that is the whole repo", () => {
    expect(
      githubSourceUrlAtCommit({
        sourceRef: "owner/repo@main:",
        commit: COMMIT,
      }),
    ).toBe(`https://github.com/owner/repo/tree/${COMMIT}`);
  });

  it("keeps a ref containing slashes out of the path", () => {
    expect(
      githubSourceUrlAtCommit({
        sourceRef: "owner/repo@release/2.0:skills/pdf",
        commit: COMMIT,
      }),
    ).toBe(`https://github.com/owner/repo/tree/${COMMIT}/skills/pdf`);
  });

  it("escapes path segments so a spaced directory still resolves", () => {
    expect(
      githubSourceUrlAtCommit({
        sourceRef: "owner/repo@main:my skills/pdf",
        commit: COMMIT,
      }),
    ).toBe(`https://github.com/owner/repo/tree/${COMMIT}/my%20skills/pdf`);
  });

  it("has no link without a commit, which is every non-GitHub version", () => {
    expect(
      githubSourceUrlAtCommit({
        sourceRef: "owner/repo@main:skills/pdf",
        commit: null,
      }),
    ).toBeNull();
  });

  it("has no link for a skill that never came from a repo", () => {
    expect(
      githubSourceUrlAtCommit({ sourceRef: null, commit: COMMIT }),
    ).toBeNull();
    expect(
      githubSourceUrlAtCommit({ sourceRef: "builtin:ops", commit: COMMIT }),
    ).toBeNull();
  });
});
