import { afterEach, expect, test, vi } from "vitest";
import { STUB_COMMIT_SHA, stubGithub } from "@/test/github-skills-stub";
import { githubRepositoryTreeService } from "./github-tree";

afterEach(() => {
  vi.unstubAllGlobals();
});

test("reuses an immutable Plugin tree within the Skills cache window", async () => {
  const fetchMock = stubGithub([
    {
      owner: "plugin-tree-cache",
      repo: "plugin",
      files: { "agents/reviewer.md": "Review changes.\n" },
    },
  ]);
  const params = {
    owner: "plugin-tree-cache",
    repo: "plugin",
    commitSha: STUB_COMMIT_SHA,
  };

  await githubRepositoryTreeService.read(params);
  await githubRepositoryTreeService.read(params);

  const treeCalls = fetchMock.mock.calls.filter(([input]) =>
    String(input).includes("/git/trees/"),
  );
  expect(treeCalls).toHaveLength(1);
});

test("does not share Plugin tree entries across authentication contexts", async () => {
  const fetchMock = stubGithub([
    {
      owner: "plugin-tree-token-isolation",
      repo: "plugin",
      files: { "agents/reviewer.md": "Review changes.\n" },
    },
  ]);
  const params = {
    owner: "plugin-tree-token-isolation",
    repo: "plugin",
    commitSha: STUB_COMMIT_SHA,
  };

  await githubRepositoryTreeService.read(params);
  await githubRepositoryTreeService.read({
    ...params,
    githubToken: "ghp_other",
  });

  const treeCalls = fetchMock.mock.calls.filter(([input]) =>
    String(input).includes("/git/trees/"),
  );
  expect(treeCalls).toHaveLength(2);
});
