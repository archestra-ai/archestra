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
  }): FakeProject {
    const project: FakeProject = {
      id: this.nextId++,
      path: params.path,
      defaultBranch: null,
      branches: new Map(),
      commits: new Map(),
      mergeRequests: [],
    };
    this.projects.set(params.path, project);
    if (params.files && Object.keys(params.files).length > 0) {
      const branch = params.branch ?? "main";
      const sha = commitSha(params.files);
      project.commits.set(sha, new Map(Object.entries(params.files)));
      project.branches.set(branch, sha);
      project.defaultBranch = branch;
    }
    return project;
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

  /** Merge a merge request: its branch's files land on the target branch. */
  merge(path: string, iid: number) {
    const project = this.mustProject(path);
    const request = project.mergeRequests.find((entry) => entry.iid === iid);
    if (!request) throw new Error(`No merge request !${iid}`);
    const sha = project.branches.get(request.sourceBranch);
    if (!sha) throw new Error("Merge request branch is gone");
    project.branches.set(request.targetBranch, sha);
    request.state = "merged";
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
      return found
        ? HttpResponse.json(mergeRequestJson(this.webUrl, project, found))
        : notFound();
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
    const sha = resolve(ref);
    if (!sha) return notFound();
    const files = project.commits.get(sha) ?? new Map<string, string>();
    if (kind === "tree") {
      const prefix = url.searchParams.get("path");
      const recursive = url.searchParams.get("recursive") === "true";
      const entries = treeEntries(files).filter((entry) =>
        prefix
          ? entry.path.startsWith(`${prefix}/`) &&
            (recursive || !entry.path.slice(prefix.length + 1).includes("/"))
          : recursive || !entry.path.includes("/"),
      );
      // Like GitLab, a path that is a file or missing is "404 Tree Not Found".
      if (prefix && entries.length === 0) return notFound();
      return HttpResponse.json(entries);
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
  mergeRequests: FakeMergeRequest[];
}

interface FakeMergeRequest {
  iid: number;
  sourceBranch: string;
  targetBranch: string;
  title: string;
  state: "opened" | "merged" | "closed";
}

function commitSha(files: Record<string, string>, parent?: string | null) {
  return createHash("sha1")
    .update(JSON.stringify([parent ?? null, Object.entries(files).sort()]))
    .digest("hex");
}

function treeEntries(files: Map<string, string>) {
  const folders = new Set<string>();
  for (const path of files.keys()) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index++)
      folders.add(parts.slice(0, index).join("/"));
  }
  return [
    ...[...folders].map((path) => ({ path, type: "tree", mode: "040000" })),
    ...[...files.keys()].map((path) => ({
      path,
      type: "blob",
      mode: "100644",
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
    detailed_merge_status: "mergeable",
  };
}

function notFound() {
  return HttpResponse.json({ message: "404 Not Found" }, { status: 404 });
}
