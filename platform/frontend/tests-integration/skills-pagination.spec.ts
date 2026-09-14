import { skillsListSeed } from "../src/mocks/data/skills";
import { expect, test } from "./fixtures";

test("standalone Skills loads one page and preserves the server total", async ({
  page,
  mswControl,
}) => {
  await mswControl.use({
    method: "get",
    url: "/api/skills",
    once: true,
    body: {
      ...skillsListSeed,
      pagination: {
        currentPage: 1,
        limit: 10,
        total: 250,
        totalPages: 25,
        hasNext: true,
        hasPrev: false,
      },
    },
  });
  const listRequests: URL[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/skills") listRequests.push(url);
  });
  await page.goto("/skills?kind=standalone&pageSize=10");
  await expect(page.getByText("Page 1 of 25", { exact: true })).toBeVisible();
  expect(listRequests).toHaveLength(1);
  expect(listRequests[0].searchParams.get("limit")).toBe("10");
  expect(listRequests[0].searchParams.get("offset")).toBe("0");
});
