import type { Locator, Page } from "@playwright/test";
import type { BlobProvider } from "../src/lib/blob-provider.query";
import { costStatisticsFor } from "../src/mocks/data/statistics";
import { expect, test } from "./fixtures";

test.use({ viewport: { width: 1280, height: 700 } });

const providers: BlobProvider[] = [
  {
    id: "scroll-s3",
    name: "Scroll S3",
    type: "s3",
    config: {
      type: "s3",
      bucket: "example-exports",
      region: "us-east-1",
      keyPrefix: "",
      endpoint: null,
      forcePathStyle: false,
      authMethod: "default_chain",
      roleArn: null,
      externalId: null,
    },
  },
  {
    id: "scroll-gcs",
    name: "Scroll GCS",
    type: "gcs",
    config: {
      type: "gcs",
      bucket: "example-exports",
      keyPrefix: "",
      authMethod: "application_default",
    },
  },
  {
    id: "scroll-azure",
    name: "Scroll Azure",
    type: "azure_blob",
    config: {
      type: "azure_blob",
      accountName: "exampleexports",
      container: "exports",
      keyPrefix: "",
      endpoint: null,
      authMethod: "default_credential",
      tenantId: null,
      clientId: null,
    },
  },
].map((provider) => ({
  ...provider,
  organizationId: "test-org",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  hasCredentials: false,
  usedBy: { costExports: [] },
})) as BlobProvider[];

const labels = {
  s3: "Amazon S3",
  gcs: "Google Cloud Storage",
  azure_blob: "Azure Blob Storage",
};

async function scrollBody(page: Page, dialog: Locator, lastField: Locator) {
  const body = dialog.locator('[data-slot="dialog-body"]');
  const header = dialog.locator('[data-slot="dialog-header"]');
  const footer = dialog.locator('[data-slot="dialog-footer"]');
  await expect(header).toBeInViewport({ ratio: 1 });
  await expect(footer).toBeInViewport({ ratio: 1 });
  const headerBefore = await header.boundingBox();
  const footerBefore = await footer.boundingBox();
  await body.hover();
  await page.mouse.wheel(0, 1500);
  await expect
    .poll(() => body.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  await expect(lastField).toBeInViewport({ ratio: 1 });
  // Being in the viewport alone would also pass for a field hidden behind
  // the opaque footer. Require it to fit inside the body's visible bounds.
  await expect
    .poll(async () => {
      const fieldBox = await lastField.boundingBox();
      const bodyBox = await body.boundingBox();
      return (
        !!fieldBox &&
        !!bodyBox &&
        fieldBox.y >= bodyBox.y &&
        fieldBox.y + fieldBox.height <= bodyBox.y + bodyBox.height
      );
    })
    .toBe(true);
  await expect(header).toHaveJSProperty("scrollTop", 0);
  expect(await header.boundingBox()).toEqual(headerBefore);
  expect(await footer.boundingBox()).toEqual(footerBefore);
  await expect(
    dialog.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeInViewport({ ratio: 1 });
  // Keyboard focus must scroll the body without displacing the shell either.
  await lastField.focus();
  expect(await header.boundingBox()).toEqual(headerBefore);
  expect(await footer.boundingBox()).toEqual(footerBefore);
}

for (const provider of providers) {
  for (const mode of ["add", "edit"] as const) {
    test(`${mode} ${provider.type}: scrolls expanded Advanced with fixed header and footer`, async ({
      page,
      mswControl,
    }) => {
      await mswControl.use({
        method: "get",
        url: "/api/blob-providers",
        body: providers,
      });
      await page.goto("/settings/blob-providers");
      if (mode === "add") {
        await page
          .getByRole("button", { name: "Add blob provider", exact: true })
          .click();
      } else {
        await page
          .getByRole("button", { name: provider.name, exact: true })
          .click();
      }
      const dialog = page.getByRole("dialog", {
        name: mode === "add" ? "Add blob provider" : "Edit blob provider",
        exact: true,
      });
      if (mode === "add" && provider.type !== "s3") {
        await dialog
          .getByRole("combobox", { name: "Provider", exact: true })
          .click();
        await page
          .getByRole("option", { name: new RegExp(labels[provider.type]) })
          .click();
      }
      await dialog
        .getByRole("button", { name: "Advanced", exact: true })
        .click();
      const lastField =
        provider.type === "s3"
          ? dialog.getByRole("switch", { name: "Path-style addressing" })
          : dialog.getByRole("textbox", {
              name: provider.type === "gcs" ? "Key prefix" : "Custom endpoint",
              exact: true,
            });
      await scrollBody(page, dialog, lastField);
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(dialog).not.toBeVisible();
    });
  }
}

test("cost export body scrolls while its schedule action stays visible", async ({
  page,
  mswControl,
}) => {
  await mswControl.registerMany([
    { method: "get", url: "/api/blob-providers", body: providers },
    { method: "get", url: "/api/cost-exports", body: [] },
    {
      method: "get",
      url: "/api/statistics/cost-savings",
      body: costStatisticsFor(new URLSearchParams()).costSavings,
    },
  ]);
  await page.goto("/llm/cost-exports");
  await page
    .getByRole("button", { name: "Schedule export", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Schedule cost export",
    exact: true,
  });
  await scrollBody(
    page,
    dialog,
    dialog.getByRole("textbox", { name: "Folder", exact: true }),
  );
  await expect(
    dialog.getByRole("button", { name: "Schedule", exact: true }),
  ).toBeInViewport({ ratio: 1 });
});
