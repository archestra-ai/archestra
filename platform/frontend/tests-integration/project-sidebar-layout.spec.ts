import type { APIRequestContext, Page } from "@playwright/test";
import { expect, test } from "./fixtures";
import type { MswControl } from "./helpers/msw-control";

const PROJECT_ID = "5d9a3c1e-7b42-4f0a-9c6e-2a8b1d4e6f70";
const PROJECT_PATH = `/api/projects/${PROJECT_ID}`;

test.use({ viewport: { width: 1280, height: 800 } });

test("renders project instructions as markdown in the sidebar", async ({
  page,
  mswControl,
  request,
}) => {
  await mockProject(mswControl, request, {
    instructions: "# Release rules\n\nAlways run **the smoke suite** first.",
    fileCount: 0,
  });
  await page.goto(`/projects/${PROJECT_ID}`);

  const sidebar = projectSidebar(page);
  await expect(
    sidebar.getByRole("heading", { name: "Release rules" }),
  ).toBeVisible();
  await expect(sidebar.getByText("the smoke suite")).toBeVisible();
  await expect(sidebar.getByText("# Release rules")).toHaveCount(0);
});

test("keeps schedules on screen when the project has many files", async ({
  page,
  mswControl,
  request,
}) => {
  await mockProject(mswControl, request, { instructions: "", fileCount: 40 });
  await page.goto(`/projects/${PROJECT_ID}`);

  const sidebar = projectSidebar(page);
  await expect(
    sidebar.getByRole("button", { name: "file-01.md", exact: true }),
  ).toBeVisible();
  await expect(
    sidebar.getByRole("heading", { name: "Schedules" }),
  ).toBeInViewport();
  await expect(sidebar.getByText("Nightly digest")).toBeInViewport();

  // The file list scrolls on its own instead of stretching the sidebar.
  const lastFile = sidebar.getByRole("button", {
    name: "file-40.md",
    exact: true,
  });
  await expect(lastFile).not.toBeInViewport();
  await lastFile.scrollIntoViewIfNeeded();
  await expect(lastFile).toBeInViewport();
  await expect(
    sidebar.getByRole("heading", { name: "Schedules" }),
  ).toBeInViewport();
});

test("separates the empty files state from the schedules divider", async ({
  page,
  mswControl,
  request,
}) => {
  await mockProject(mswControl, request, { instructions: "", fileCount: 0 });
  await page.goto(`/projects/${PROJECT_ID}`);

  const sidebar = projectSidebar(page);
  const empty = sidebar.getByText(
    "Add files for your agent to use in this project.",
  );
  await expect(empty).toBeVisible();
  const emptyBox = await empty.boundingBox();
  // The divider under the Files section is the next block's top border, so it
  // sits at the section's bottom edge.
  const sectionBox = await empty
    .locator("xpath=ancestor::section[1]")
    .boundingBox();
  if (!emptyBox || !sectionBox) {
    throw new Error("Empty files state must be rendered in its section");
  }
  const gap = sectionBox.y + sectionBox.height - (emptyBox.y + emptyBox.height);
  expect(gap).toBeGreaterThanOrEqual(12);
});

function projectSidebar(page: Page) {
  return page.locator("section", { hasText: "Instructions" }).locator("..");
}

async function mockProject(
  mswControl: MswControl,
  request: APIRequestContext,
  params: { instructions: string; fileCount: number },
) {
  const permissions = await (
    await request.get("/internal-test/api/api/user/permissions")
  ).json();
  await mswControl.use({
    method: "get",
    url: "/api/user/permissions",
    body: {
      ...permissions,
      project: ["read", "create", "update", "delete"],
      scheduledTask: ["read", "create", "update", "delete"],
      file: ["manage"],
    },
  });
  await mswControl.use({
    method: "get",
    url: PROJECT_PATH,
    body: {
      id: PROJECT_ID,
      name: "Release train",
      description: null,
      icon: null,
      viewerRole: "owner",
      ownerName: "Admin",
      createdBy: null,
      labels: [],
      conversationCount: 0,
      visibility: "user",
      shareTeamNames: null,
      shareUserNames: null,
      pinnedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      deletedAt: null,
      shareTeamIds: null,
      shareUserIds: null,
      defaultAgent: null,
    },
  });
  await mswControl.use({
    method: "get",
    url: `${PROJECT_PATH}/instructions`,
    body: { content: params.instructions },
  });
  await mswControl.use({
    method: "get",
    url: `${PROJECT_PATH}/files`,
    body: Array.from({ length: params.fileCount }, (_, i) => {
      const n = String(i + 1).padStart(2, "0");
      return {
        id: `file-row-${n}`,
        downloadRef: `ref-${n}`,
        filename: `file-${n}.md`,
        mimeType: "text/markdown",
        sizeBytes: 128,
        createdAt: "2026-01-01T00:00:00.000Z",
        downloadable: true,
        projectId: PROJECT_ID,
        projectName: "Release train",
      };
    }),
  });
  await mswControl.use({
    method: "get",
    url: `${PROJECT_PATH}/conversations`,
    body: [],
  });
  await mswControl.use({
    method: "get",
    url: `${PROJECT_PATH}/runs`,
    body: [],
  });
  await mswControl.use({
    method: "get",
    url: "/api/members/default-model",
    body: { modelId: null, chatApiKeyId: null },
  });
  await mswControl.use({
    method: "get",
    url: "/api/schedule-triggers/trigger-1/runs",
    body: {
      data: [],
      pagination: {
        currentPage: 1,
        limit: 1,
        total: 0,
        totalPages: 0,
        hasNext: false,
        hasPrev: false,
      },
    },
  });
  await mswControl.use({
    method: "get",
    url: "/api/schedule-triggers",
    body: {
      data: [
        {
          id: "trigger-1",
          organizationId: "org-1",
          name: "Nightly digest",
          agentId: "agent-1",
          projectId: PROJECT_ID,
          messageTemplate: "Summarize the day",
          cronExpression: "0 2 * * *",
          timezone: "UTC",
          enabled: true,
          actorUserId: "user-1",
          lastExecutedAt: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          agent: { id: "agent-1", name: "Reporter", agentType: "agent" },
        },
      ],
      pagination: {
        currentPage: 1,
        limit: 20,
        total: 1,
        totalPages: 1,
        hasNext: false,
        hasPrev: false,
      },
    },
  });
}
