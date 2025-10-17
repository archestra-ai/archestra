import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const githubTool = createTool({
  id: "github-operations",
  description:
    "Interact with GitHub repositories - get issues, create issues, read files, and browse directories",
  inputSchema: z.object({
    action: z.enum([
      "get_issue",
      "create_issue",
      "get_file_content",
      "list_directory_contents",
    ]),
    owner: z.string().describe("Repository owner/organization"),
    repo: z.string().describe("Repository name"),
    issue_number: z.number().optional().describe("Issue number for get_issue"),
    title: z.string().optional().describe("Title for create_issue"),
    body: z.string().optional().describe("Body content for create_issue"),
    file_path: z
      .string()
      .optional()
      .describe(
        "File path for get_file_content or directory path for list_directory_contents",
      ),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    data: z.any(),
    message: z.string().optional(),
  }),
  execute: async ({ context }) => {
    const { action, owner, repo, issue_number, title, body, file_path } =
      context;
    const baseUrl = `https://api.github.com/repos/${owner}/${repo}`;

    // GitHub token from environment (optional for public repos)
    const headers: Record<string, string> = {
      Accept: "application/vnd.github.v3+json",
      "User-Agent": "Mastra-GitHub-Agent",
    };

    if (process.env.GITHUB_TOKEN) {
      headers["Authorization"] = `token ${process.env.GITHUB_TOKEN}`;
    }

    try {
      switch (action) {
        case "get_issue": {
          if (!issue_number) {
            throw new Error("Issue number is required for get_issue action");
          }

          const issueResponse = await fetch(
            `${baseUrl}/issues/${issue_number}`,
            { headers },
          );

          if (!issueResponse.ok) {
            throw new Error(
              `Failed to fetch issue: ${issueResponse.status} ${issueResponse.statusText}`,
            );
          }

          const issue = await issueResponse.json();
          return {
            success: true,
            data: {
              id: issue.id,
              number: issue.number,
              title: issue.title,
              body: issue.body,
              state: issue.state,
              created_at: issue.created_at,
              updated_at: issue.updated_at,
              user: {
                login: issue.user.login,
                avatar_url: issue.user.avatar_url,
              },
              labels: issue.labels.map((label: any) => label.name),
              html_url: issue.html_url,
            },
            message: "Issue retrieved successfully",
          };
        }

        case "create_issue": {
          if (!title || !body) {
            throw new Error(
              "Title and body are required for create_issue action",
            );
          }

          const createResponse = await fetch(`${baseUrl}/issues`, {
            method: "POST",
            headers: {
              ...headers,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ title, body }),
          });

          if (!createResponse.ok) {
            throw new Error(
              `Failed to create issue: ${createResponse.status} ${createResponse.statusText}`,
            );
          }

          const newIssue = await createResponse.json();
          return {
            success: true,
            data: {
              issue_url: newIssue.html_url,
              issue_number: newIssue.number,
              id: newIssue.id,
            },
            message: "Issue created successfully",
          };
        }

        case "get_file_content": {
          if (!file_path) {
            throw new Error(
              "File path is required for get_file_content action",
            );
          }

          const fileResponse = await fetch(`${baseUrl}/contents/${file_path}`, {
            headers,
          });

          if (!fileResponse.ok) {
            throw new Error(
              `Failed to fetch file: ${fileResponse.status} ${fileResponse.statusText}`,
            );
          }

          const fileData = await fileResponse.json();

          if (fileData.type !== "file") {
            throw new Error("Path does not point to a file");
          }

          const content = Buffer.from(fileData.content, "base64").toString(
            "utf-8",
          );
          return {
            success: true,
            data: {
              content,
              path: file_path,
              size: fileData.size,
              sha: fileData.sha,
              download_url: fileData.download_url,
            },
            message: "File content retrieved successfully",
          };
        }

        case "list_directory_contents": {
          const directoryPath = file_path || "";
          const dirResponse = await fetch(
            `${baseUrl}/contents/${directoryPath}`,
            { headers },
          );

          if (!dirResponse.ok) {
            throw new Error(
              `Failed to fetch directory: ${dirResponse.status} ${dirResponse.statusText}`,
            );
          }

          const dirData = await dirResponse.json();

          if (!Array.isArray(dirData)) {
            throw new Error("Path does not point to a directory");
          }

          return {
            success: true,
            data: {
              path: directoryPath || "/",
              contents: dirData.map((item: any) => ({
                name: item.name,
                path: item.path,
                type: item.type,
                size: item.size,
                download_url: item.download_url,
              })),
            },
            message: "Directory contents retrieved successfully",
          };
        }

        default:
          throw new Error(`Unknown action: ${action}`);
      }
    } catch (exception: unknown) {
      return {
        success: false,
        data: null,
        message:
          exception instanceof Error
            ? `GitHub API error: ${exception.message}`
            : `GitHub API error: ${String(exception)}`,
      };
    }
  },
});
