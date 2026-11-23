import type { archestraApiTypes } from "@archestra/shared";
import { organizationSeed } from "../src/mocks/data/organization";
import { expect, test } from "./fixtures";

type FileList = archestraApiTypes.GetKnowledgeFilesResponse;
type Directory = archestraApiTypes.GetKnowledgeDirectoriesResponse[number];

const folder: Directory = {
  id: "22222222-2222-4222-8222-222222222222",
  organizationId: organizationSeed.id,
  name: "Research",
  visibility: "org",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  createdBy: null,
  createdByServiceAccountId: null,
  teamIds: [],
  fileCount: 1,
};

function fileList(directoryId: string | null): FileList {
  return {
    data: [
      {
        id: directoryId
          ? "33333333-3333-4333-8333-333333333333"
          : "44444444-4444-4444-8444-444444444444",
        organizationId: organizationSeed.id,
        directoryId,
        visibility: "org",
        filename: directoryId ? "notes.txt" : "unfiled.txt",
        mimeType: "text/plain",
        sizeBytes: 13,
        contentHash: "test",
        createdAt: "2026-01-01T00:00:00Z",
        createdBy: null,
        createdByServiceAccountId: null,
        knowledgeBases: [],
        teamIds: [],
        labels: [],
      },
    ],
    pagination: {
      currentPage: directoryId ? 1 : 2,
      limit: 10,
      total: directoryId ? 1 : 11,
      totalPages: directoryId ? 1 : 2,
      hasNext: false,
      hasPrev: !directoryId,
    },
  };
}

test("Files restores the directory and page on browser Back and Forward", async ({
  page,
  mswControl,
}) => {
  await mswControl.registerMany([
    {
      method: "get",
      url: "/api/organization",
      body: {
        ...organizationSeed,
        embeddingChatApiKeyId: "11111111-1111-4111-8111-111111111111",
        embeddingModel: "text-embedding-3-small",
      },
    },
    { method: "get", url: "/api/knowledge-directories", body: [folder] },
    {
      method: "get",
      url: "/api/knowledge-files",
      query: { directoryId: "root" },
      body: fileList(null),
    },
    {
      method: "get",
      url: "/api/knowledge-files",
      query: { directoryId: folder.id },
      body: fileList(folder.id),
    },
  ]);

  await page.goto("/knowledge/files?page=2&pageSize=10");
  await expect(page.getByText("unfiled.txt", { exact: true })).toBeVisible();
  const rootUrl = page.url();
  await page.getByRole("button", { name: /^Research/ }).click();
  await expect(page.getByText("notes.txt", { exact: true })).toBeVisible();
  const folderUrl = page.url();
  const params = new URL(folderUrl).searchParams;
  expect(params.get("directoryId")).toBe(folder.id);
  expect(params.get("page")).toBe("1");
  expect(params.get("pageSize")).toBe("10");

  await page.getByRole("checkbox", { name: "Select notes.txt" }).check();
  await page.goBack();
  await expect(page).toHaveURL(rootUrl);
  await expect(page.getByText("unfiled.txt", { exact: true })).toBeVisible();

  await page.goForward();
  await expect(page).toHaveURL(folderUrl);
  await expect(page.getByText("notes.txt", { exact: true })).toBeVisible();

  await expect(
    page.getByRole("checkbox", { name: "Select notes.txt" }),
  ).not.toBeChecked();

  await page.reload();
  await expect(page.getByText("notes.txt", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "All files" }).click();
  await expect(page.getByText("unfiled.txt", { exact: true })).toBeVisible();
  expect(new URL(page.url()).searchParams.has("directoryId")).toBe(false);
  await page.goBack();
  await expect(page).toHaveURL(folderUrl);
  await expect(page.getByText("notes.txt", { exact: true })).toBeVisible();
});
