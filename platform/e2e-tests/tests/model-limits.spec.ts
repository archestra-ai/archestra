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
// figure: 123000 renders as "123K" there, and "123,000" in the field.
const CONTEXT_WINDOW = 123_000;
const MAX_OUTPUT_TOKENS = 7_000;
const CONTEXT_WINDOW_TYPED = "123,000";
const MAX_OUTPUT_TOKENS_TYPED = "7,000";

type ModelRow = {
  id: string;
  modelId: string;
  customContextLength: number | null;
  customOutputLength: number | null;
};

/**
 * A model whose id no other row shares. Two providers can serve the same id
 * (`gpt-4o` under OpenAI and Azure, say), and both the row locator and the
 * "Edit <id>" button would then match twice.
 */
function pickUniqueModel(
  models: ModelRow[],
  predicate: (model: ModelRow) => boolean = () => true,
): ModelRow | undefined {
  const idCounts = new Map<string, number>();
  for (const model of models) {
    idCounts.set(model.modelId, (idCounts.get(model.modelId) ?? 0) + 1);
  }
  return models.find(
    (model) => idCounts.get(model.modelId) === 1 && predicate(model),
  );
}

test.describe("Model context and output limits", () => {
  test("sets and clears a model's limits from the Models page", async ({
    page,
    request,
    getModels,
  }) => {
    const models: ModelRow[] = await (await getModels(request)).json();
    // No override yet: the test restores the model by clearing, so it must not
    // start out carrying one.
    const model = pickUniqueModel(
      models,
      (row) =>
        row.customContextLength === null && row.customOutputLength === null,
    );
    test.skip(!model, "No model without limit overrides in this environment");
    if (!model) return;

    await page.goto(`${UI_BASE_URL}/llm/models`);
    // Narrow to one row so the assertions below cannot read another model's
    // cells, and so the row survives pagination.
    await page.getByPlaceholder(/search models/i).fill(model.modelId);
    // Exact matches throughout: the search is a substring filter, so an id
    // like `gpt-4o` also brings up `gpt-4o-mini`, whose row would otherwise
    // answer the assertions below.
    const row = page
      .getByRole("row")
      .filter({ has: page.getByText(model.modelId, { exact: true }) });
    await expect(row).toHaveCount(1);

    // The dialog opens on its first page; the limits live on their own.
    const openLimitsPage = async () => {
      await page
        .getByRole("button", { name: `Edit ${model.modelId}`, exact: true })
        .click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await dialog.getByRole("button", { name: "Limits", exact: true }).click();
      return dialog;
    };

    const dialog = await openLimitsPage();
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
    // They read back grouped, the way they were entered.
    const reopened = await openLimitsPage();
    await expect(reopened.getByLabel("Context window (tokens)")).toHaveValue(
      CONTEXT_WINDOW_TYPED,
    );
    await expect(reopened.getByLabel("Max output tokens")).toHaveValue(
      MAX_OUTPUT_TOKENS_TYPED,
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

  test("blocks a rejected limit even from another page of the dialog", async ({
    page,
    request,
    getModels,
  }) => {
    const models: ModelRow[] = await (await getModels(request)).json();
    const model = pickUniqueModel(models);
    test.skip(!model, "No models in this environment");
    if (!model) return;

    await page.goto(`${UI_BASE_URL}/llm/models`);
    await page.getByPlaceholder(/search models/i).fill(model.modelId);
    await page
      .getByRole("button", { name: `Edit ${model.modelId}`, exact: true })
      .click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Limits", exact: true }).click();
    await dialog.getByLabel("Context window (tokens)").fill("0");

    // Away from the page that holds the bad value, then save. The pages are
    // hidden rather than unmounted precisely so the rule still runs here.
    await dialog
      .getByRole("button", { name: "Availability", exact: true })
      .click();
    await dialog.getByRole("button", { name: "Save Changes" }).click();

    // Blocked, and the page holding the rejected value comes back — the
    // message is no use on a page the user cannot see.
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Must be 1 or greater");
    await expect(dialog.getByLabel("Context window (tokens)")).toBeVisible();
  });
});
