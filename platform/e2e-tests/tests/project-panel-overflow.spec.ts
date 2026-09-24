import type { APIResponse } from "@playwright/test";
import { UI_BASE_URL } from "../consts";
import { expect, test } from "../fixtures";

/**
 * The project page's right-hand file panel is one of several children laid
 * out inside a shared, viewport-locked scroll container
 * (`[data-page-scroll-container]`). Whether that container ends up with
 * scrollable overflow depends on real browser layout (clamped-text
 * measurement, flex sizing, nested `overflow` containment) that jsdom cannot
 * reproduce, so this class of "the whole page scrolls out of bounds" bug is
 * only observable with a real layout engine.
 *
 * Long instructions content plus a full file list are seeded through the API
 * (rather than stubbed) because that combination is what originally
 * triggered the bug: the instructions preview clamps at a fixed height, and
 * without `overflow-hidden` on the panel's content wrapper, the clipped
 * overflow — compounded by a file list tall enough to need its own scroller —
 * leaked past the panel and out to the page's own scroll container. Neither
 * alone reproduced it.
 */
const LONG_INSTRUCTIONS = Array.from(
  { length: 40 },
  (_, i) => `Instruction line ${i + 1}: keep this project's context in mind.`,
).join("\n\n");

const FILE_NAMES = [
  "reports-q1.md",
  "reports-q2.md",
  "reports-q3.md",
  "reports-q4.md",
  "reports-summary.json",
  "app-new.html",
  "app-publish.html",
  "index-new.json",
  "notes-1.md",
  "notes-2.md",
  "notes-3.md",
  "notes-4.md",
  "notes-5.md",
  "data-export.json",
  "readme.md",
  "changelog.md",
  "design-doc.md",
  "meeting-notes.md",
  "roadmap.md",
  "archive.json",
];

const mimeTypeFor = (name: string): string => {
  if (name.endsWith(".json")) return "application/json";
  if (name.endsWith(".html")) return "text/html";
  return "text/markdown";
};

test.use({ viewport: { width: 1400, height: 900 } });

test("project page content stays within the page's scroll container", async ({
  page,
  goToPage,
  makeRandomString,
}) => {
  const name = makeRandomString(8, "panel-overflow-project");
  const createResponse = await page.request.post(
    `${UI_BASE_URL}/api/projects`,
    {
      data: { name },
    },
  );
  await expectOk(createResponse);
  const project = await createResponse.json();

  try {
    await expectOk(
      await page.request.put(
        `${UI_BASE_URL}/api/projects/${project.id}/instructions`,
        { data: { content: LONG_INSTRUCTIONS } },
      ),
    );

    for (const fileName of FILE_NAMES) {
      await expectOk(
        await page.request.post(
          `${UI_BASE_URL}/api/projects/${project.id}/files`,
          {
            data: {
              name: fileName,
              mimeType: mimeTypeFor(fileName),
              dataBase64: Buffer.from(
                `Content for ${fileName}\n`.repeat(20),
              ).toString("base64"),
            },
          },
        ),
      );
    }

    await goToPage(page, `/projects/${project.id}`);

    const heading = page.getByRole("heading", { level: 1 });
    await expect(heading).toBeVisible();

    // Wait for the instructions and file list to finish loading: both are
    // fetched after navigation, and the layout only reaches its buggy (or
    // fixed) shape once the clamped instructions and the full file list have
    // actually rendered.
    await expect(page.getByRole("button", { name: "Show more" })).toBeVisible();
    await expect(
      page.getByText(FILE_NAMES[FILE_NAMES.length - 1], { exact: true }),
    ).toBeVisible();

    const scrollContainer = page.locator("[data-page-scroll-container]");

    const before = await scrollContainer.evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));
    expect(before.scrollHeight).toBeLessThanOrEqual(before.clientHeight);

    const headingTopBefore = (await heading.first().boundingBox())?.y;

    // Dragging the container the way a mouse-wheel or trackpad scroll would
    // must not move it: there is nothing left for it to scroll.
    await scrollContainer.evaluate((el) => {
      el.scrollTop = 500;
    });
    const scrollTopAfter = await scrollContainer.evaluate((el) => el.scrollTop);
    expect(scrollTopAfter).toBe(0);

    const headingTopAfter = (await heading.first().boundingBox())?.y;
    expect(headingTopAfter).toBe(headingTopBefore);
  } finally {
    await expectOk(
      await page.request.delete(`${UI_BASE_URL}/api/projects/${project.id}`),
    );
    await expectOk(
      await page.request.delete(
        `${UI_BASE_URL}/api/projects/${project.id}/permanent`,
      ),
    );
  }
});

async function expectOk(response: APIResponse): Promise<void> {
  expect(response.ok(), `${response.status()} ${await response.text()}`).toBe(
    true,
  );
}
