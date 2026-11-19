import { createHash } from "node:crypto";
import { HttpResponse, http } from "msw";

/**
 * An in-memory GitLab REST API (v4) for msw: projects with branches, commits,
 * files, groups and merge requests. Enough of GitLab for Git sync tests to
 * exercise real request shapes, including nested group paths, the token
 * header, protected branches and merge requests.
 */
export class FakeGitlab {
  readonly projects = new Map<string, FakeProject>();
  readonly groups: { id: number; full_path: string }[] = [];
  readonly requests: { method: string; path: string }[] = [];
  /** Branches a direct commit is refused on, as GitLab does for protected branches. */
  readonly protectedBranches = new Set<string>();
  /** Commit statuses posted, in order. */
  readonly statuses: {
    sha: string;
    state: string;
    name: string;
    description?: string;
  }[] = [];
  /** The most entries a keyset tree page returns, to test paging with few files. */
  treePageSize = 100;
  private nextId = 1;

  constructor(
    readonly webUrl: string,
    readonly token: string,
  ) {}

  /** A project; `files` become its first commit on `branch` unless empty. */
  addProject(params: {
    path: string;
    files?: Record<string, string>;
    branch?: string;
    /** Paths among `files` that are symbolic links (mode 120000). */
    symlinks?: string[];
  }): FakeProject {
    const project: FakeProject = {
      id: this.nextId++,
      path: params.path,
      defaultBranch: null,
      branches: new Map(),
      commits: new Map(),
      parents: new Map(),
      authors: new Map(),
      symlinks: new Set(params.symlinks ?? []),
      mergeRequests: [],
    };
    this.projects.set(params.path, project);
    if (params.files && Object.keys(params.files).length > 0) {
      const branch = params.branch ?? "main";
      const sha = commitSha(params.files);
      project.commits.set(sha, new Map(Object.entries(params.files)));
      project.parents.set(sha, null);
      project.branches.set(branch, sha);
      project.defaultBranch = branch;
    }
    return project;
  }

  /** A commit on `branch` that sets `files` over its tip; returns its sha. */
  commit(
    path: string,
    branch: string,
    files: Record<string, string>,
    author = FAKE_USER.email,
  ): string {
    const project = this.mustProject(path);
    const parent = project.branches.get(branch) ?? null;
    const next = new Map(parent ? project.commits.get(parent) : []);
    for (const [file, content] of Object.entries(files))
      next.set(file, content);
    const sha = commitSha(Object.fromEntries(next), parent);
    project.commits.set(sha, next);
    project.parents.set(sha, parent);
    project.authors.set(sha, author);
    project.branches.set(branch, sha);
    return sha;
  }

  /** A branch's tip. */
  branchHead(path: string, branch: string): string {
    const sha = this.mustProject(path).branches.get(branch);
    if (!sha) throw new Error(`No branch ${branch}`);
    return sha;
  }

  /** Point a branch at a commit it had before, as a force push would. */
  setBranch(path: string, branch: string, sha: string) {
    const project = this.mustProject(path);
    if (!project.commits.has(sha)) throw new Error(`No commit ${sha}`);
    project.branches.set(branch, sha);
  }

  /** A merge request's source branch. */
  sourceBranch(path: string, iid: number): string {
    const request = this.mustProject(path).mergeRequests.find(
      (entry) => entry.iid === iid,
    );
    if (!request) throw new Error(`No merge request !${iid}`);
    return request.sourceBranch;
  }

  addGroup(fullPath: string) {
    this.groups.push({ id: this.nextId++, full_path: fullPath });
  }

  /** Files on a branch's tip. */
  files(path: string, branch: string): Record<string, string> {
    const project = this.mustProject(path);
    const sha = project.branches.get(branch);
    return sha ? Object.fromEntries(project.commits.get(sha) ?? []) : {};
  }

  /** Remove a merge request's source branch, as GitLab does after a merge. */
  deleteSourceBranch(path: string, iid: number) {
    const project = this.mustProject(path);
    const request = project.mergeRequests.find((entry) => entry.iid === iid);
    if (!request) throw new Error(`No merge request !${iid}`);
    project.branches.delete(request.sourceBranch);
  }

  /** Merge a merge request: its branch's files land on the target branch. */
  merge(path: string, iid: number) {
    const project = this.mustProject(path);
    const request = project.mergeRequests.find((entry) => entry.iid === iid);
    if (!request) throw new Error(`No merge request !${iid}`);
    const sha = project.branches.get(request.sourceBranch);
    if (!sha) throw new Error("Merge request branch is gone");
    project.branches.set(request.targetBranch, sha);
    request.state = "merged";
    // A fast-forward: the head itself lands, with no merge commit.
    request.mergedSha = sha;
  }

  handlers() {
    const base = `${this.webUrl}/api/v4`;
    return [
      http.all(
        ({ request }) => request.url.startsWith(`${base}/`),
        async ({ request }) => {
          if (request.headers.get("private-token") !== this.token)
            return HttpResponse.json(
              { message: "401 Unauthorized" },
              { status: 401 },
            );
          const url = new URL(request.url);
          const segments = url.pathname
            .slice(new URL(base).pathname.length + 1)
            .split("/")
            .map(decodeURIComponent);
          this.requests.push({
            method: request.method,
            path: segments.join("/"),
          });
          return this.route({ request, url, segments });
        },
      ),
    ];
  }

  // === internals ===

  private async route(params: {
    request: Request;
    url: URL;
    segments: string[];
  }): Promise<Response> {
    const { request, url, segments } = params;
    const method = request.method;
    const [resource, id, ...rest] = segments;
    if (resource === "personal_access_tokens" && id === "self")
      return HttpResponse.json({ scopes: ["api"], active: true });
    if (resource === "user" && !id) return HttpResponse.json(FAKE_USER);
    if (resource === "groups" && method === "GET")
      return HttpResponse.json(this.groups);
    if (resource !== "projects") return notFound();
    if (!id) {
      if (method === "POST") {
        const body = (await request.json()) as {
          path: string;
          namespace_id?: number;
        };
        const group = this.groups.find(
          (entry) => entry.id === body.namespace_id,
        );
        const path = `${group?.full_path ?? "token-owner"}/${body.path}`;
        if (this.projects.has(path))
          return HttpResponse.json(
            { message: { path: ["has already been taken"] } },
            { status: 400 },
          );
        return HttpResponse.json(projectJson(this.addProject({ path })), {
          status: 201,
        });
      }
      return HttpResponse.json(
        [...this.projects.values()].map((project) => projectJson(project)),
      );
    }
    const project = this.projects.get(id);
    if (!project) return notFound();
    if (rest.length === 0) return HttpResponse.json(projectJson(project));
    const [area, kind, name, raw] = rest;
    if (area === "statuses" && kind && method === "POST") {
      const body = (await request.json()) as {
        state: string;
        name: string;
        description?: string;
      };
      this.statuses.push({ sha: kind, ...body });
      return HttpResponse.json({ id: this.statuses.length }, { status: 201 });
    }
    if (area === "merge_requests" && !kind && method === "GET") {
      const state = url.searchParams.get("state");
      const target = url.searchParams.get("target_branch");
      const source = url.searchParams.get("source_branch");
      return HttpResponse.json(
        project.mergeRequests
          .filter(
            (entry) =>
              (!state || entry.state === state) &&
              (!target || entry.targetBranch === target) &&
              (!source || entry.sourceBranch === source),
          )
          .map((entry) => mergeRequestJson(this.webUrl, project, entry)),
      );
    }
    if (area === "merge_requests") {
      if (method === "POST") {
        const body = (await request.json()) as {
          source_branch: string;
          target_branch: string;
          title: string;
        };
        const created: FakeMergeRequest = {
          iid: project.mergeRequests.length + 1,
          sourceBranch: body.source_branch,
          targetBranch: body.target_branch,
          baseSha: project.branches.get(body.target_branch) ?? null,
          title: body.title,
          state: "opened",
        };
        project.mergeRequests.push(created);
        return HttpResponse.json(
          mergeRequestJson(this.webUrl, project, created),
          {
            status: 201,
          },
        );
      }
      const found = project.mergeRequests.find(
        (entry) => entry.iid === Number(kind),
      );
      if (!found) return notFound();
      if (name === "commits") {
        // The source branch's commits past the target's, newest first.
        const base = found.baseSha;
        const commits: { id: string; author_email: string }[] = [];
        for (
          let at = found.mergedSha ?? project.branches.get(found.sourceBranch);
          at && at !== base;
          at = project.parents.get(at) ?? undefined
        )
          commits.push({
            id: at,
            author_email: project.authors.get(at) ?? FAKE_USER.email,
          });
        return HttpResponse.json(commits);
      }
      return HttpResponse.json(mergeRequestJson(this.webUrl, project, found));
    }
    if (area !== "repository") return notFound();
    const ref = url.searchParams.get("ref");
    const resolve = (target: string | null) => {
      if (!target) return null;
      const sha = project.branches.get(target) ?? target;
      return project.commits.has(sha) ? sha : null;
    };
    if (kind === "commits" && method === "POST") {
      const body = (await request.json()) as {
        branch: string;
        start_branch?: string;
        start_sha?: string;
        commit_message: string;
        actions: {
          action: "create" | "update" | "delete";
          file_path: string;
          content?: string;
        }[];
      };
      if (this.protectedBranches.has(body.branch))
        return HttpResponse.json(
          { message: "You are not allowed to push into this branch" },
          { status: 403 },
        );
      if (body.start_branch && body.start_sha)
        return HttpResponse.json(
          { error: "start_branch, start_sha are mutually exclusive" },
          { status: 400 },
        );
      if (body.start_sha && !project.commits.has(body.start_sha))
        return HttpResponse.json(
          { message: "Invalid start_sha" },
          { status: 400 },
        );
      const parent =
        body.start_sha ??
        project.branches.get(body.start_branch ?? body.branch) ??
        null;
      const parentOf = parent;
      const files = new Map(parent ? project.commits.get(parent) : []);
      for (const action of body.actions) {
        if (action.action === "delete") files.delete(action.file_path);
        else if (action.action === "create" && files.has(action.file_path))
          return HttpResponse.json(
            { message: "A file with this name already exists" },
            { status: 400 },
          );
        else files.set(action.file_path, action.content ?? "");
      }
      const sha = commitSha(Object.fromEntries(files), parent);
      project.commits.set(sha, files);
      project.parents.set(sha, parentOf);
      project.authors.set(sha, FAKE_USER.email);
      project.branches.set(body.branch, sha);
      project.defaultBranch ??= body.branch;
      return HttpResponse.json({ id: sha }, { status: 201 });
    }
    if (kind === "commits") {
      const sha = resolve(name ?? null);
      return sha ? HttpResponse.json({ id: sha }) : notFound();
    }
    if (kind === "branches") {
      const sha = project.branches.get(name ?? "");
      return sha ? HttpResponse.json({ commit: { id: sha } }) : notFound();
    }
    if (kind === "merge_base") {
      const [first, second] = url.searchParams
        .getAll("refs[]")
        .map((target) => resolve(target));
      if (!first || !second) return notFound();
      const history = (sha: string) => {
        const seen: string[] = [];
        for (
          let at: string | null = sha;
          at;
          at = project.parents.get(at) ?? null
        )
          seen.push(at);
        return seen;
      };
      const ofFirst = new Set(history(first));
      const base = history(second).find((sha) => ofFirst.has(sha));
      return base ? HttpResponse.json({ id: base }) : notFound();
    }
    const sha = resolve(ref);
    if (!sha) return notFound();
    const files = project.commits.get(sha) ?? new Map<string, string>();
    if (kind === "tree") {
      const prefix = url.searchParams.get("path");
      const recursive = url.searchParams.get("recursive") === "true";
      const entries = treeEntries(files, project.symlinks).filter((entry) =>
        prefix
          ? entry.path.startsWith(`${prefix}/`) &&
            (recursive || !entry.path.slice(prefix.length + 1).includes("/"))
          : recursive || !entry.path.includes("/"),
      );
      // Like GitLab, a path that is a file or missing is "404 Tree Not Found".
      if (prefix && entries.length === 0) return notFound();
      if (url.searchParams.get("pagination") !== "keyset")
        return HttpResponse.json(entries);
      // Keyset pages, each naming the next in its Link header.
      const size = Math.min(
        Number(url.searchParams.get("per_page") ?? 20),
        this.treePageSize,
      );
      const after = url.searchParams.get("page_token");
      const start = after
        ? entries.findIndex((entry) => entry.path === after) + 1
        : 0;
      const page = entries.slice(start, start + size);
      const last = page.at(-1);
      if (start + size >= entries.length || !last)
        return HttpResponse.json(page);
      const next = new URL(url);
      next.searchParams.set("page_token", last.path);
      return HttpResponse.json(page, {
        headers: { Link: `<${next.href}>; rel="next"` },
      });
    }
    if (kind === "files" && name) {
      const content = files.get(name);
      if (content === undefined) return notFound();
      if (raw === "raw") return new HttpResponse(content);
      return HttpResponse.json({ file_path: name, size: content.length });
    }
    return notFound();
  }

  private mustProject(path: string): FakeProject {
    const project = this.projects.get(path);
    if (!project) throw new Error(`No fake GitLab project ${path}`);
    return project;
  }
}

export interface FakeProject {
  id: number;
  path: string;
  defaultBranch: string | null;
  branches: Map<string, string>;
  commits: Map<string, Map<string, string>>;
  /** Each commit's parent, null for a first commit. */
  parents: Map<string, string | null>;
  /** Each commit's author email; the token's user unless a test says otherwise. */
  authors: Map<string, string>;
  /** Paths that are symbolic links, in every commit. */
  symlinks: Set<string>;
  mergeRequests: FakeMergeRequest[];
}

interface FakeMergeRequest {
  iid: number;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  state: "opened" | "merged" | "closed";
  /** The target branch's tip when the request was opened. */
  baseSha: string | null;
  /** What merging put on the target branch. */
  mergedSha?: string;
}

/** Who the fake's token acts as. */
const FAKE_USER = {
  username: "sync-bot",
  name: "Sync Bot",
  email: "sync-bot@example.test",
};

function commitSha(files: Record<string, string>, parent?: string | null) {
  return createHash("sha1")
    .update(JSON.stringify([parent ?? null, Object.entries(files).sort()]))
    .digest("hex");
}

function treeEntries(files: Map<string, string>, symlinks?: Set<string>) {
  const folders = new Set<string>();
  for (const path of files.keys()) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index++)
      folders.add(parts.slice(0, index).join("/"));
  }
  const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
  return [
    ...[...folders].map((path) => ({
      id: createHash("sha1").update(`tree ${path}`).digest("hex"),
      name: nameOf(path),
      path,
      type: "tree",
      mode: "040000",
    })),
    ...[...files].map(([path, content]) => ({
      // Like a blob id, the same content keeps the same id.
      id: createHash("sha1").update(`blob ${content}`).digest("hex"),
      name: nameOf(path),
      path,
      type: "blob",
      mode: symlinks?.has(path) ? "120000" : "100644",
    })),
  ];
}

function projectJson(project: FakeProject) {
  return {
    id: project.id,
    path_with_namespace: project.path,
    default_branch: project.defaultBranch,
    visibility: "private",
    empty_repo: project.branches.size === 0,
  };
}

function mergeRequestJson(
  webUrl: string,
  project: FakeProject,
  request: FakeMergeRequest,
) {
  return {
    iid: request.iid,
    web_url: `${webUrl}/${project.path}/-/merge_requests/${request.iid}`,
    state: request.state,
    source_branch: request.sourceBranch,
    target_branch: request.targetBranch,
    detailed_merge_status: "mergeable",
    sha: request.mergedSha ?? project.branches.get(request.sourceBranch),
    merge_commit_sha: null,
    squash_commit_sha: null,
  };
}

function notFound() {
  return HttpResponse.json({ message: "404 Not Found" }, { status: 404 });
}
