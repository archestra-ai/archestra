/**
 * MCP-UI GitHub Wrapper
 *
 * An MCP server that wraps GitHub API calls and returns rich UIResource
 * responses for rendering in the Archestra Chat UI.
 *
 * Tools:
 * - list_repos: Lists user repositories as an interactive HTML table
 * - view_pull_request: Shows a PR with diff stats, reviewers, and status
 * - search_issues: Searches issues and renders a sortable results table
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Octokit } from "@octokit/rest";

const octokit = new Octokit({
    auth: process.env.GITHUB_TOKEN,
});

const server = new Server(
    { name: "mcp-ui-github", version: "1.0.0" },
    { capabilities: { tools: { listChanged: false } } },
);

// =============================================================================
// Tool definitions
// =============================================================================

server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
        {
            name: "list_repos",
            title: "List GitHub Repositories",
            description:
                "List repositories for a user or organization. Returns an interactive HTML table with repo stats.",
            inputSchema: {
                type: "object" as const,
                properties: {
                    username: {
                        type: "string",
                        description:
                            "GitHub username or org name. Defaults to authenticated user.",
                    },
                    sort: {
                        type: "string",
                        enum: ["updated", "created", "pushed", "full_name"],
                        description: "Sort field (default: updated)",
                    },
                },
            },
            annotations: {},
            _meta: {},
        },
        {
            name: "view_pull_request",
            title: "View Pull Request",
            description:
                "View a pull request with rich UI showing diff stats, reviewers, checks status, and labels.",
            inputSchema: {
                type: "object" as const,
                properties: {
                    owner: { type: "string", description: "Repository owner" },
                    repo: { type: "string", description: "Repository name" },
                    pull_number: {
                        type: "number",
                        description: "Pull request number",
                    },
                },
                required: ["owner", "repo", "pull_number"],
            },
            annotations: {},
            _meta: {},
        },
        {
            name: "search_issues",
            title: "Search GitHub Issues",
            description:
                "Search GitHub issues and pull requests. Returns a rich HTML table with filters.",
            inputSchema: {
                type: "object" as const,
                properties: {
                    query: {
                        type: "string",
                        description:
                            "Search query (GitHub search syntax, e.g. 'repo:owner/name is:open label:bug')",
                    },
                    per_page: {
                        type: "number",
                        description: "Results per page (default: 10, max: 30)",
                    },
                },
                required: ["query"],
            },
            annotations: {},
            _meta: {},
        },
    ],
}));

// =============================================================================
// Tool execution
// =============================================================================

server.setRequestHandler(
    CallToolRequestSchema,
    async ({ params: { name, arguments: args } }) => {
        switch (name) {
            case "list_repos":
                return handleListRepos(args as { username?: string; sort?: string });

            case "view_pull_request":
                return handleViewPullRequest(
                    args as { owner: string; repo: string; pull_number: number },
                );

            case "search_issues":
                return handleSearchIssues(
                    args as { query: string; per_page?: number },
                );

            default:
                return {
                    content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
                    isError: true,
                };
        }
    },
);

// =============================================================================
// Start server
// =============================================================================

const transport = new StdioServerTransport();
await server.connect(transport);

// =============================================================================
// Tool handlers
// =============================================================================

async function handleListRepos(args: { username?: string; sort?: string }) {
    const { username, sort = "updated" } = args;

    const response = username
        ? await octokit.repos.listForUser({
            username,
            sort: sort as "updated" | "created" | "pushed" | "full_name",
            per_page: 20,
        })
        : await octokit.repos.listForAuthenticatedUser({
            sort: sort as "updated" | "created" | "pushed" | "full_name",
            per_page: 20,
        });

    const repos = response.data;

    const html = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 16px; background: #0d1117; color: #e6edf3; }
  h2 { font-size: 16px; margin-bottom: 12px; color: #f0f6fc; }
  .count { color: #8b949e; font-weight: normal; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; padding: 8px 12px; border-bottom: 1px solid #30363d; color: #8b949e; font-weight: 600; font-size: 11px; text-transform: uppercase; }
  td { padding: 8px 12px; border-bottom: 1px solid #21262d; }
  tr:hover td { background: #161b22; }
  a { color: #58a6ff; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .lang { display: inline-flex; align-items: center; gap: 4px; }
  .lang-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
  .stars { color: #e3b341; }
  .private { color: #f85149; font-size: 11px; padding: 2px 6px; background: rgba(248,81,73,0.1); border-radius: 12px; }
  .desc { color: #8b949e; max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
</head><body>
<h2>📦 Repositories <span class="count">(${repos.length})</span></h2>
<table>
  <thead><tr><th>Name</th><th>Description</th><th>Language</th><th>⭐</th><th>🍴</th><th>Updated</th></tr></thead>
  <tbody>
    ${repos
            .map(
                (r) => `
    <tr>
      <td><a href="${r.html_url}" target="_blank">${r.name}</a>${r.private ? ' <span class="private">private</span>' : ""}</td>
      <td class="desc">${r.description || "—"}</td>
      <td><span class="lang">${r.language ? `<span class="lang-dot" style="background:${languageColor(r.language)}"></span>${r.language}` : "—"}</span></td>
      <td class="stars">${r.stargazers_count}</td>
      <td>${r.forks_count}</td>
      <td>${timeAgo(r.updated_at || "")}</td>
    </tr>`,
            )
            .join("")}
  </tbody>
</table>
</body></html>`;

    return createUiResourceResponse(`ui://github/repos/${username || "me"}`, html);
}

async function handleViewPullRequest(args: {
    owner: string;
    repo: string;
    pull_number: number;
}) {
    const { owner, repo, pull_number } = args;

    const [pr, reviews, files] = await Promise.all([
        octokit.pulls.get({ owner, repo, pull_number }),
        octokit.pulls.listReviews({ owner, repo, pull_number, per_page: 10 }),
        octokit.pulls.listFiles({ owner, repo, pull_number, per_page: 30 }),
    ]);

    const prData = pr.data;
    const reviewData = reviews.data;
    const fileData = files.data;

    const stateColor =
        prData.state === "open"
            ? "#3fb950"
            : prData.merged
                ? "#a371f7"
                : "#f85149";
    const stateIcon =
        prData.state === "open" ? "🟢" : prData.merged ? "🟣" : "🔴";

    const html = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 16px; background: #0d1117; color: #e6edf3; }
  .header { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; }
  .title { font-size: 18px; font-weight: 600; }
  .number { color: #8b949e; }
  .badge { padding: 4px 10px; border-radius: 16px; font-size: 12px; font-weight: 600; color: white; background: ${stateColor}; }
  .meta { display: flex; gap: 16px; margin-bottom: 16px; font-size: 13px; color: #8b949e; }
  .section { margin-bottom: 16px; }
  .section-title { font-size: 13px; font-weight: 600; color: #8b949e; text-transform: uppercase; margin-bottom: 8px; }
  .stats { display: flex; gap: 16px; }
  .stat { padding: 8px 16px; background: #161b22; border-radius: 8px; text-align: center; }
  .stat-value { font-size: 20px; font-weight: 700; }
  .stat-label { font-size: 11px; color: #8b949e; }
  .additions { color: #3fb950; }
  .deletions { color: #f85149; }
  .files { font-size: 13px; }
  .file { padding: 6px 0; border-bottom: 1px solid #21262d; display: flex; justify-content: space-between; }
  .file-name { color: #58a6ff; }
  .file-stats span { margin-left: 8px; }
  .reviews { display: flex; gap: 8px; flex-wrap: wrap; }
  .review { padding: 4px 10px; background: #161b22; border-radius: 8px; font-size: 12px; display: flex; align-items: center; gap: 4px; }
  .labels { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
  .label { padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; }
</style>
</head><body>
  <div class="header">
    <span class="badge">${stateIcon} ${prData.merged ? "Merged" : prData.state}</span>
    <span class="title">${escapeHtml(prData.title)}</span>
    <span class="number">#${pull_number}</span>
  </div>

  <div class="meta">
    <span>by <strong>${prData.user?.login}</strong></span>
    <span>${prData.base.ref} ← ${prData.head.ref}</span>
    <span>${prData.commits} commits</span>
    <span>${prData.comments} comments</span>
  </div>

  <div class="section">
    <div class="section-title">Changes</div>
    <div class="stats">
      <div class="stat"><div class="stat-value">${fileData.length}</div><div class="stat-label">Files</div></div>
      <div class="stat"><div class="stat-value additions">+${prData.additions}</div><div class="stat-label">Additions</div></div>
      <div class="stat"><div class="stat-value deletions">-${prData.deletions}</div><div class="stat-label">Deletions</div></div>
    </div>
  </div>

  ${reviewData.length > 0
            ? `
  <div class="section">
    <div class="section-title">Reviews</div>
    <div class="reviews">
      ${reviewData
                .map(
                    (r) =>
                        `<div class="review">${reviewIcon(r.state)} ${r.user?.login}</div>`,
                )
                .join("")}
    </div>
  </div>`
            : ""
        }

  <div class="section">
    <div class="section-title">Files Changed</div>
    <div class="files">
      ${fileData
            .slice(0, 15)
            .map(
                (f) => `
      <div class="file">
        <span class="file-name">${f.filename}</span>
        <span class="file-stats"><span class="additions">+${f.additions}</span><span class="deletions">-${f.deletions}</span></span>
      </div>`,
            )
            .join("")}
      ${fileData.length > 15 ? `<div class="file" style="color:#8b949e">...and ${fileData.length - 15} more files</div>` : ""}
    </div>
  </div>

  ${prData.labels.length > 0
            ? `
  <div class="labels">
    ${prData.labels.map((l) => `<span class="label" style="background:${l.color ? `#${l.color}33` : "#30363d"};color:${l.color ? `#${l.color}` : "#8b949e"}">${l.name}</span>`).join("")}
  </div>`
            : ""
        }
</body></html>`;

    return createUiResourceResponse(
        `ui://github/pr/${owner}/${repo}/${pull_number}`,
        html,
    );
}

async function handleSearchIssues(args: {
    query: string;
    per_page?: number;
}) {
    const { query, per_page = 10 } = args;

    const response = await octokit.search.issuesAndPullRequests({
        q: query,
        per_page: Math.min(per_page, 30),
    });

    const items = response.data.items;

    const html = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 16px; background: #0d1117; color: #e6edf3; }
  h2 { font-size: 16px; margin-bottom: 4px; color: #f0f6fc; }
  .subtitle { color: #8b949e; font-size: 13px; margin-bottom: 12px; }
  .item { padding: 10px 0; border-bottom: 1px solid #21262d; }
  .item:hover { background: #161b22; }
  .item-header { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
  .item-title a { color: #58a6ff; text-decoration: none; font-weight: 600; font-size: 14px; }
  .item-title a:hover { text-decoration: underline; }
  .item-meta { font-size: 12px; color: #8b949e; }
  .state-open { color: #3fb950; }
  .state-closed { color: #f85149; }
  .labels { display: inline-flex; gap: 4px; margin-left: 8px; }
  .label { padding: 1px 6px; border-radius: 12px; font-size: 10px; font-weight: 600; }
  .icon { font-size: 16px; }
</style>
</head><body>
<h2>🔍 Search Results</h2>
<div class="subtitle">${response.data.total_count} results for "${escapeHtml(query)}"</div>
${items
            .map(
                (item) => `
<div class="item">
  <div class="item-header">
    <span class="icon">${item.pull_request ? "🔀" : "📋"}</span>
    <span class="item-title"><a href="${item.html_url}" target="_blank">${escapeHtml(item.title)}</a></span>
    <span class="${item.state === "open" ? "state-open" : "state-closed"}">${item.state}</span>
    ${item.labels.length > 0 ? `<span class="labels">${item.labels.map((l) => `<span class="label" style="background:${typeof l !== "string" && l.color ? `#${l.color}33` : "#30363d"};color:${typeof l !== "string" && l.color ? `#${l.color}` : "#8b949e"}">${typeof l === "string" ? l : l.name}</span>`).join("")}</span>` : ""}
  </div>
  <div class="item-meta">
    ${item.repository_url?.split("/").slice(-2).join("/")} #${item.number} • ${item.user?.login} • ${timeAgo(item.updated_at)}
    ${item.comments > 0 ? `• 💬 ${item.comments}` : ""}
  </div>
</div>`,
            )
            .join("")}
</body></html>`;

    return createUiResourceResponse(
        `ui://github/search/${encodeURIComponent(query)}`,
        html,
    );
}

// =============================================================================
// Helpers
// =============================================================================

function createUiResourceResponse(uri: string, html: string) {
    return {
        content: [
            {
                type: "resource" as const,
                resource: {
                    uri,
                    mimeType: "text/html",
                    text: html,
                },
            },
        ],
    };
}

function escapeHtml(str: string): string {
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function timeAgo(dateStr: string): string {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    return `${Math.floor(days / 30)}mo ago`;
}

function reviewIcon(state: string): string {
    switch (state) {
        case "APPROVED":
            return "✅";
        case "CHANGES_REQUESTED":
            return "🔴";
        case "COMMENTED":
            return "💬";
        default:
            return "⏸️";
    }
}

function languageColor(lang: string): string {
    const colors: Record<string, string> = {
        TypeScript: "#3178c6",
        JavaScript: "#f1e05a",
        Python: "#3572A5",
        Rust: "#dea584",
        Go: "#00ADD8",
        Java: "#b07219",
        Ruby: "#701516",
        C: "#555555",
        "C++": "#f34b7d",
        "C#": "#178600",
        Scala: "#c22d40",
        Swift: "#F05138",
        Kotlin: "#A97BFF",
        PHP: "#4F5D95",
        Shell: "#89e051",
    };
    return colors[lang] || "#8b949e";
}
