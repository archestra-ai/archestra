import { UI_BASE_URL } from "../consts";
import { expect, test } from "./api-fixtures";

/**
 * A provider catalog does not always publish a model's context window or its
 * output ceiling — self-hosted endpoints and proxy-discovered rows routinely
 * publish neither — so both are editable per model. This walks the round trip
 * a catalog admin makes: set the two limits, see them in the table, clear them
 * back to whatever the provider reports.
 */

// Recognisable in the table and unlikely to collide with a provider's own
// figure: 123000 renders as "123K", 7000 as "7K".
const CONTEXT_WINDOW = 123_000;
const MAX_OUTPUT_TOKENS = 7_000;

type ModelRow = {
  id: string;
  modelId: string;
  customContextLength: number | null;
  customOutputLength: number | null;
};

test.describe("Model context and output limits", () => {
  test("sets and clears a model's limits from the Models page", async ({
    page,
    request,
    getModels,
  }) => {
    const models: ModelRow[] = await (await getModels(request)).json();
    // Any model with no override yet: the test restores it by clearing, so it
    // must not start out carrying one.
    const model = models.find(
      (row) =>
        row.customContextLength === null && row.customOutputLength === null,
    );
    test.skip(!model, "No model without limit overrides in this environment");
    if (!model) return;

    await page.goto(`${UI_BASE_URL}/llm/models`);
    // Narrow to one row so the assertions below cannot read another model's
    // cells, and so the row survives pagination.
    await page.getByPlaceholder(/search models/i).fill(model.modelId);
    // Exact matches throughout: the search is a substring filter, and an id
    // like `gpt-4o` also matches `gpt-4o-mini`, whose row would then answer
    // the assertions below.
    const row = page
      .getByRole("row")
      .filter({ has: page.getByText(model.modelId, { exact: true }) });
    await expect(row).toHaveCount(1);

    const openEditor = async () => {
      await page
        .getByRole("button", { name: `Edit ${model.modelId}`, exact: true })
        .click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      return dialog;
    };

    const dialog = await openEditor();
    await dialog
      .getByLabel("Context window (tokens)")
      .fill(String(CONTEXT_WINDOW));
    await dialog
      .getByLabel("Max output tokens")
      .fill(String(MAX_OUTPUT_TOKENS));
    await dialog.getByRole("button", { name: "Save Changes" }).click();
    await expect(dialog).toBeHidden();

    // The table reads the saved override, not the form state.
    await expect(row).toContainText("123K");
    await expect(row).toContainText("7K");

    // Reopening shows the saved values, so a later edit starts from them
    // instead of from an empty field that would clear the override on save.
    const reopened = await openEditor();
    await expect(reopened.getByLabel("Context window (tokens)")).toHaveValue(
      String(CONTEXT_WINDOW),
    );
    await expect(reopened.getByLabel("Max output tokens")).toHaveValue(
      String(MAX_OUTPUT_TOKENS),
    );

    // Emptying a field clears the override rather than storing a zero, which
    // is the only way back to the provider's own number.
    await reopened.getByLabel("Context window (tokens)").fill("");
    await reopened.getByLabel("Max output tokens").fill("");
    await reopened.getByRole("button", { name: "Save Changes" }).click();
    await expect(reopened).toBeHidden();

    await expect(row).not.toContainText("123K");
    await expect(row).not.toContainText("7K");
  });

  test("rejects a limit that is not a whole number of tokens", async ({
    page,
    request,
    getModels,
  }) => {
    const models: ModelRow[] = await (await getModels(request)).json();
    const model = models[0];
    test.skip(!model, "No models in this environment");
    if (!model) return;

    await page.goto(`${UI_BASE_URL}/llm/models`);
    await page.getByPlaceholder(/search models/i).fill(model.modelId);
    await page
      .getByRole("button", { name: `Edit ${model.modelId}`, exact: true })
      .click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Context window (tokens)").fill("1.5");
    await dialog.getByRole("button", { name: "Save Changes" }).click();

    // Caught in the form. Without the client-side rule this reached the update
    // route and came back as a bare 400, which reads like a failed save.
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Must be a whole number of tokens");
  });
});
