import { randomUUID } from "node:crypto";
import type { GitAccess } from "@/git-hosts/git-access";
import { gitClient } from "@/git-hosts/git-access";
import {
  type GitHostClient,
  GitHostError,
  type GitlabProject,
} from "@/git-hosts/git-host-client";
import { OPENAPPA_TEMPLATE } from "@/openappa/template.generated";
import { ApiError } from "@/types";
import type { AppaGithubRepositoryStatus } from "@/types/openappa-github-app-setup";

/**
 * GitLab (cloud or self-managed) as an OpenAPPA policy source. Mirrors the
 * GitHub paths in openappa-github-sync and openappa-policy-change: merge
 * requests stand in for pull requests, and new projects start from the bundled
 * template since GitLab can't copy a GitHub template.
 */
class OpenAppaGitlab {
  /** The policy file at the source's ref, and the commit it was read at. */
  async readPolicy(params: {
    access: GitAccess;
    repo: string;
    ref: string | null;
    path: string;
  }): Promise<{ pending: null; commitSha: string; content: string }> {
    const client = gitClient(params.access);
    return withGitlabErrors(async () => {
      const commitSha = await client.resolveCommit(params.repo, params.ref);
      if (!/^[a-f0-9]{40}$/.test(commitSha))
        throw new ApiError(400, "GitLab returned an invalid commit");
      const bytes = await client.readFile({
        repo: params.repo,
        ref: commitSha,
        path: params.path,
        maxBytes: POLICY_MAX_BYTES,
      });
      if (!bytes)
        throw new ApiError(
          400,
          `Policy file not found: ${params.path} in ${params.repo} at ${commitSha.slice(0, 7)}, or it exceeds the 1 MiB limit. Check the policy file with Edit source.`,
        );
      return {
        pending: null,
        commitSha,
        content: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      };
    });
  }

  /** `.appa` files directly inside `directory` at the accepted commit. */
  async loadPolicyTests(params: {
    access: GitAccess;
    repo: string;
    commitSha: string;
    directory: string;
    allowEmpty?: boolean;
  }): Promise<{ path: string; content: string }[]> {
    const client = gitClient(params.access);
    return withGitlabErrors(async () => {
      const tree = await client.listTree(params.repo, params.commitSha);
      const directory = params.directory.replace(/\/+$/, "");
      const folderExists = tree.some(
        (entry) => entry.type === "tree" && entry.path === directory,
      );
      if (!folderExists) {
        if (params.allowEmpty) return [];
        throw new ApiError(
          404,
          "Policy test directory was not found at the accepted commit; check repository access and path",
        );
      }
      const paths = tree
        .filter(
          (entry) =>
            entry.type === "blob" &&
            entry.path.endsWith(".appa") &&
            entry.path.startsWith(`${directory}/`) &&
            !entry.path.slice(directory.length + 1).includes("/"),
        )
        .map((entry) => entry.path)
        .sort();
      if (paths.length > MAX_POLICY_TESTS)
        throw new ApiError(
          400,
          `Choose a test directory with at most ${MAX_POLICY_TESTS} .appa files`,
        );
      if (paths.length === 0 && !params.allowEmpty)
        throw new ApiError(
          404,
          "No .appa test files exist directly inside this directory at the accepted commit",
        );
      const files: { path: string; content: string }[] = [];
      let total = 0;
      for (const path of paths) {
        const bytes = await client.readFile({
          repo: params.repo,
          ref: params.commitSha,
          path,
          maxBytes: POLICY_TEST_MAX_BYTES,
        });
        if (!bytes)
          throw new ApiError(
            400,
            "A policy test exceeds the 64 KiB file limit",
          );
        total += bytes.length;
        if (total > POLICY_TESTS_MAX_BYTES)
          throw new ApiError(
            400,
            "Policy test collection exceeds the 512 KiB limit",
          );
        files.push({
          path,
          content: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        });
      }
      return files;
    });
  }

  /** What setup would do with a project: seed it, connect it, or warn. */
  async repositoryStatus(params: {
    access: GitAccess;
    repo: string;
    ref?: string;
    path: string;
    validationDirectory: string;
  }): Promise<AppaGithubRepositoryStatus> {
    const client = gitClient(params.access);
    let project: GitlabProject | null;
    try {
      project = await client.gitlabProject(params.repo);
    } catch (error) {
      return {
        status:
          error instanceof GitHostError && error.status === 401
            ? "app_error"
            : "unreachable",
        validations: null,
      };
    }
    if (!project) return { status: "unreachable", validations: null };
    if (project.empty_repo || !project.default_branch)
      return { status: "empty", validations: null };
    const ref = params.ref || project.default_branch;
    const [policy, validations] = await Promise.all([
      client
        .pathExists({ repo: params.repo, ref, path: params.path })
        .catch(() => false),
      client
        .pathExists({
          repo: params.repo,
          ref,
          path: params.validationDirectory,
        })
        .catch(() => false),
    ]);
    return { status: policy ? "policy" : "other", validations };
  }

  /** Projects the token is a member of, for setup's repository list. */
  async repositories(access: GitAccess) {
    const projects = await withGitlabErrors(() =>
      gitClient(access).listRepositories(),
    );
    return {
      repositories: projects.map((project) => ({
        fullName: project.path,
        private: project.private,
        description: null,
        template: false,
      })),
      // GitLab tokens are scoped where they were created, not on a shared page.
      manageUrl: null,
    };
  }

  /** Groups the token can create a policy project in. */
  async namespaces(access: GitAccess): Promise<string[]> {
    const groups = await withGitlabErrors(() =>
      gitClient(access).gitlabNamespaces(),
    );
    return groups.map((group) => group.fullPath);
  }

  /**
   * Create a private project in `namespace` (or the token owner's own) and
   * seed it with the template plus the current policy.
   */
  async createProject(params: {
    access: GitAccess;
    namespace: string | null;
    name: string;
    policy: string;
  }): Promise<{ repo: string; branch: string }> {
    const client = gitClient(params.access);
    return withGitlabErrors(async () => {
      let namespaceId: number | undefined;
      if (params.namespace) {
        const match = (await client.gitlabNamespaces()).find(
          (group) =>
            group.fullPath.toLowerCase() === params.namespace?.toLowerCase(),
        );
        if (!match)
          throw new ApiError(
            400,
            `The GitLab token can't create projects in ${params.namespace}`,
          );
        namespaceId = match.id;
      }
      const project = await client.createGitlabProject({
        namespaceId,
        name: params.name,
      });
      const seeded = await this.seed({
        client,
        repo: project.path_with_namespace,
        branch: project.default_branch || "main",
        policy: params.policy,
      });
      return { repo: project.path_with_namespace, ...seeded };
    });
  }

  /** Seed an existing empty project with the template and current policy. */
  async seedExisting(params: {
    access: GitAccess;
    repo: string;
    policy: string;
  }): Promise<{ branch: string }> {
    const client = gitClient(params.access);
    return withGitlabErrors(async () => {
      const project = await client.gitlabProject(params.repo);
      if (!project)
        throw new ApiError(404, `${params.repo} was not found on GitLab`);
      return this.seed({
        client,
        repo: params.repo,
        branch: project.default_branch || "main",
        policy: params.policy,
      });
    });
  }

  /**
   * Propose policy and validation changes as one commit on a new branch from
   * `baseSha`, then a merge request into the source branch.
   */
  async proposeChange(params: {
    access: GitAccess;
    repo: string;
    branch: string;
    baseSha: string;
    title: string;
    summary: string;
    upsert: { path: string; content: string }[];
    delete: string[];
  }): Promise<{ iid: number; webUrl: string }> {
    const client = gitClient(params.access);
    return withGitlabErrors(async () => {
      const tree = await client.listTree(params.repo, params.baseSha);
      const existing = new Map(tree.map((entry) => [entry.path, entry]));
      for (const path of [
        ...params.upsert.map((file) => file.path),
        ...params.delete,
      ]) {
        const entry = existing.get(path);
        if (entry && (entry.type !== "blob" || entry.mode === "120000"))
          throw new ApiError(
            400,
            `${path} is not a regular file in the repository`,
          );
      }
      const head = `archestra/openappa-${randomUUID()}`;
      await client.commitGitlabFiles({
        repo: params.repo,
        branch: head,
        startBranch: params.branch,
        startSha: params.baseSha,
        message: params.title,
        actions: [
          ...params.upsert.map((file) => ({
            action: existing.has(file.path)
              ? ("update" as const)
              : ("create" as const),
            path: file.path,
            content: file.content,
          })),
          ...params.delete
            .filter((path) => existing.has(path))
            .map((path) => ({ action: "delete" as const, path })),
        ],
      });
      return client.createGitlabMergeRequest({
        repo: params.repo,
        sourceBranch: head,
        targetBranch: params.branch,
        title: params.title,
        description: params.summary,
      });
    });
  }

  /** A policy merge request this deployment opened. */
  async changeStatus(params: { access: GitAccess; repo: string; iid: number }) {
    const request = await withGitlabErrors(() =>
      gitClient(params.access).gitlabMergeRequest(params.repo, params.iid),
    );
    if (!request.sourceBranch.startsWith("archestra/openappa-"))
      throw new ApiError(404, "OpenAPPA policy merge request not found");
    return request;
  }

  async branchCommit(params: {
    access: GitAccess;
    repo: string;
    branch: string;
  }): Promise<string> {
    return withGitlabErrors(() =>
      gitClient(params.access).gitlabBranchCommit(params.repo, params.branch),
    );
  }

  async defaultBranch(params: {
    access: GitAccess;
    repo: string;
  }): Promise<string> {
    return withGitlabErrors(() =>
      gitClient(params.access).defaultBranch(params.repo),
    );
  }

  // === internals ===

  /**
   * Write the template, with the current policy as appa.toml, as the first
   * commit. An empty project has no branch a merge request could target, so a
   * refused first push is reported rather than worked around.
   */
  private async seed(params: {
    client: GitHostClient;
    repo: string;
    branch: string;
    policy: string;
  }): Promise<{ branch: string }> {
    const files = OPENAPPA_TEMPLATE.files.map((file) =>
      file.path === "appa.toml" ? { ...file, content: params.policy } : file,
    );
    try {
      await params.client.commitGitlabFiles({
        repo: params.repo,
        branch: params.branch,
        message: "Add the OpenAPPA template and current policy",
        actions: files.map((file) => ({
          action: "create" as const,
          path: file.path,
          content: file.content,
        })),
      });
    } catch (error) {
      if (error instanceof GitHostError && error.status === 403)
        throw new ApiError(
          400,
          `GitLab refused the first commit to ${params.repo}. Use a token with the Maintainer role, or allow the initial push to ${params.branch}.`,
        );
      throw error;
    }
    return { branch: params.branch };
  }
}

export const openappaGitlab = new OpenAppaGitlab();

const POLICY_MAX_BYTES = 1024 * 1024;
const POLICY_TEST_MAX_BYTES = 65536;
const POLICY_TESTS_MAX_BYTES = 524288;
const MAX_POLICY_TESTS = 32;

/** GitLab failures become API errors that name what went wrong. */
async function withGitlabErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof GitHostError)
      throw new ApiError(
        error.status === 401 || error.status === 403 ? 400 : 502,
        `GitLab: ${error.message}`,
      );
    throw error;
  }
}
