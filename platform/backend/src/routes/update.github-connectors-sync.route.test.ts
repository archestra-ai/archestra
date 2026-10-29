import { HttpResponse, http } from "msw";
import { connectorSyncService } from "@/knowledge-base/connector-sync";
import { KbDocumentModel, KnowledgeBaseConnectorModel } from "@/models";
import KbChunkModel from "@/models/kb-chunk";
import TaskModel from "@/models/task";
import { secretManager } from "@/secrets-manager";
import { describe, expect, test } from "@/test";
import { useMswServer } from "@/test/msw";
import { useRouteTestApp } from "@/test/route-test-app";
import type { GithubConfig } from "@/types/knowledge-connector";
import type { BatchEmbeddingPayload } from "@/types/task";
import knowledgeBaseRoutes from "./knowledge-base";

const API = "https://github-fixture.example.test";
const paths = [
  "README.md",
  "docs/guide.md",
  "docs/private/internal.md",
  "docs-internal/leak.md",
  "docs/wrong-type.txt",
  "handbook/guide.txt",
  "handbook/private/internal.txt",
  "handbook/wrong-type.md",
];

describe("PUT GitHub connector settings through knowledge ingestion", () => {
  const ctx = useRouteTestApp(knowledgeBaseRoutes);
  const network = useMswServer();

  test("syncs exactly the saved per-repository selection into its assigned knowledge base", async ({
    makeMember,
    makeKnowledgeBase,
    makeKnowledgeBaseConnector,
  }) => {
    await makeMember(ctx.user.id, ctx.organizationId, { role: "admin" });
    const kb = await makeKnowledgeBase(ctx.organizationId);
    const connector = await makeKnowledgeBaseConnector(
      kb.id,
      ctx.organizationId,
      {
        connectorType: "github",
        config: {
          type: "github",
          githubUrl: API,
          owner: "alpha",
          repos: ["alpha/repo-a"],
          includeIssues: false,
          includePullRequests: false,
          includeRepositoryFiles: false,
        },
      },
    );
    const secret = await secretManager().createSecret(
      { apiToken: "in-memory-github-fixture-token" },
      "GitHub ingestion test fixture",
    );
    await KnowledgeBaseConnectorModel.update(connector.id, {
      secretId: secret.id,
    });

    const savedConfig: GithubConfig = {
      type: "github",
      githubUrl: API,
      owner: "alpha",
      repos: ["alpha/repo-a", "beta/repo-b"],
      includeIssues: true,
      includePullRequests: true,
      includeRepositoryFiles: true,
      labelsToSkip: ["skip"],
      includePaths: ["docs"],
      repositoryOverrides: [
        {
          repository: "alpha/repo-a",
          includeIssues: true,
          includePullRequests: false,
          includeRepositoryFiles: true,
          labelsToSkip: ["skip"],
          fileTypes: [".md"],
          includePaths: ["docs"],
          excludePaths: ["docs/private"],
        },
        {
          repository: "beta/repo-b",
          includeIssues: false,
          includePullRequests: true,
          includeRepositoryFiles: true,
          labelsToSkip: [],
          fileTypes: [".txt"],
          includePaths: ["handbook"],
          excludePaths: ["handbook/private"],
        },
      ],
    };
    const response = await ctx.app.inject({
      method: "PUT",
      url: `/api/connectors/${connector.id}`,
      payload: { config: savedConfig },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(
      (await KnowledgeBaseConnectorModel.findById(connector.id))?.config,
    ).toEqual(savedConfig);

    network.use(
      http.get(`${API}/repos/:owner/:repo`, ({ params }) =>
        HttpResponse.json({
          default_branch: "main",
          html_url: `https://github.example.test/${params.owner}/${params.repo}`,
        }),
      ),
      http.get(`${API}/repos/:owner/:repo/issues`, ({ params }) =>
        HttpResponse.json(
          [1, 2, 3, 4].map((number) => ({
            number,
            title: `${params.repo} item ${number}`,
            body: `Body ${params.repo} ${number}`,
            state: "open",
            html_url: `https://github.example.test/${params.owner}/${params.repo}/issues/${number}`,
            user: { login: "fixture-author" },
            labels: number % 2 === 0 ? [{ name: "skip" }] : [],
            updated_at: "2026-01-15T12:00:00.000Z",
            ...(number >= 3 ? { pull_request: { url: "fixture-pr" } } : {}),
          })),
        ),
      ),
      http.get(`${API}/repos/:owner/:repo/issues/:number/comments`, () =>
        HttpResponse.json([]),
      ),
      http.get(`${API}/repos/:owner/:repo/git/ref/:ref`, () =>
        HttpResponse.json({ object: { sha: "fixture-tree" } }),
      ),
      http.get(`${API}/repos/:owner/:repo/git/trees/:sha`, () =>
        HttpResponse.json({
          tree: paths.map((path) => ({ type: "blob", path, sha: path })),
          truncated: false,
        }),
      ),
      http.get(`${API}/repos/:owner/:repo/contents/:filePath`, ({ params }) => {
        const path = Array.isArray(params.filePath)
          ? params.filePath.join("/")
          : params.filePath;
        return HttpResponse.json({
          content: Buffer.from(
            `Content ${params.owner}/${params.repo}/${path}`,
          ).toString("base64"),
          encoding: "base64",
        });
      }),
    );

    // The service receives only an ID: both configuration and credentials must
    // be loaded from the row saved by the authenticated update above.
    const result = await connectorSyncService.executeSync(connector.id);
    expect(result.status).toBe("success");
    const documents = await KbDocumentModel.findByKnowledgeBase({
      knowledgeBaseId: kb.id,
    });
    expect(
      documents
        .map(({ sourceId, content, metadata }) => ({
          sourceId,
          content,
          metadata,
        }))
        .sort((left, right) =>
          (left.sourceId ?? "").localeCompare(right.sourceId ?? ""),
        ),
    ).toEqual([
      {
        sourceId: "repo-a#1",
        content: "# Issue: repo-a item 1\n\nBody repo-a 1",
        metadata: {
          repo: "alpha/repo-a",
          number: 1,
          state: "open",
          kind: "issue",
          labels: [],
          author: "fixture-author",
        },
      },
      {
        sourceId: "repo-a#file:docs/guide.md",
        content: "Content alpha/repo-a/docs/guide.md",
        metadata: {
          repo: "alpha/repo-a",
          filePath: "docs/guide.md",
          kind: "repository_file",
          fileKind: "repository_file",
        },
      },
      {
        sourceId: "repo-b#3",
        content: "# Pull Request: repo-b item 3\n\nBody repo-b 3",
        metadata: {
          repo: "beta/repo-b",
          number: 3,
          state: "open",
          kind: "pr",
          labels: [],
          author: "fixture-author",
        },
      },
      {
        sourceId: "repo-b#4",
        content: "# Pull Request: repo-b item 4\n\nBody repo-b 4",
        metadata: {
          repo: "beta/repo-b",
          number: 4,
          state: "open",
          kind: "pr",
          labels: ["skip"],
          author: "fixture-author",
        },
      },
      {
        sourceId: "repo-b#file:handbook/guide.txt",
        content: "Content beta/repo-b/handbook/guide.txt",
        metadata: {
          repo: "beta/repo-b",
          filePath: "handbook/guide.txt",
          kind: "repository_file",
          fileKind: "repository_file",
        },
      },
    ]);
    expect(
      documents.every((document) => document.connectorId === connector.id),
    ).toBe(true);
    for (const document of documents) {
      const chunks = await KbChunkModel.findByDocument(document.id);
      expect(chunks.length, document.sourceId ?? document.id).toBeGreaterThan(
        0,
      );
      expect(
        chunks.some((chunk) => chunk.content.includes(document.content)),
      ).toBe(true);
    }
    const queuedDocumentIds: string[] = [];
    for (
      let task = await TaskModel.dequeue(["batch_embedding"]);
      task;
      task = await TaskModel.dequeue(["batch_embedding"])
    ) {
      const payload = task.payload as BatchEmbeddingPayload;
      expect(payload.connectorRunId).toBe(result.runId);
      queuedDocumentIds.push(...payload.documentIds);
    }
    expect(queuedDocumentIds.sort()).toEqual(
      documents.map((document) => document.id).sort(),
    );
    expect(new Set(queuedDocumentIds).size).toBe(queuedDocumentIds.length);
  });
});
