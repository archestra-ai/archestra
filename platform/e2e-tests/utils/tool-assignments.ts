import {
  E2eTestId,
  getAgentToolCatalogPillTestId,
  getAssignmentComboboxDisabledOptionTestId,
  getAssignmentComboboxOptionTestId,
  getAssignmentComboboxSearchInputTestId,
} from "@archestra/shared";
import { expect, type Page } from "@playwright/test";
import { goToPage } from "../fixtures";

type AssignmentTarget = {
  page: Page;
  targetName: string;
  catalogItemName: string;
  pagePath: "/agents" | "/mcp/gateways";
  dialogTitle: "Edit Agent" | "Edit MCP Gateway";
};

export async function openGatewayCatalogToolAssignment(params: {
  page: Page;
  gatewayName: string;
  catalogItemName: string;
}) {
  return await openCatalogToolAssignment({
    page: params.page,
    targetName: params.gatewayName,
    catalogItemName: params.catalogItemName,
    pagePath: "/mcp/gateways",
    dialogTitle: "Edit MCP Gateway",
  });
}

export async function saveOpenProfileDialog(page: Page): Promise<void> {
  // The per-server tool-config modal has no submit of its own (its choices
  // commit live; the only control is the Close X) and while it is open the
  // layer beneath is aria-hidden, so no role query can reach the edit
  // dialog's Save/Update. It normally auto-closes after the credential
  // choice commits, but on slow runners it can linger — wait briefly for
  // the auto-close, then close it manually.
  const configModal = page
    .getByRole("dialog")
    .filter({ has: page.getByTestId(E2eTestId.TokenSelect) })
    .first();
  if (await configModal.isVisible().catch(() => false)) {
    const autoClosed = await configModal
      .waitFor({ state: "hidden", timeout: 3_000 })
      .then(() => true)
      .catch(() => false);
    if (!autoClosed) {
      await configModal.getByRole("button", { name: "Close" }).click();
      await expect(configModal).toBeHidden({ timeout: 5_000 });
    }
  }

  // One combined locator: sampling Save's visibility at a single instant and
  // falling back to Update races the dialog's render (isVisible() does not
  // wait). A dialog has exactly one submit — wait for whichever it is.
  const submitButton = page
    .getByRole("button", { name: /^(Save|Update)$/ })
    .first();
  await expect(submitButton).toBeVisible({ timeout: 15_000 });
  await submitButton.click();

  await page.waitForLoadState("domcontentloaded");
}

function personalPinConfirmButton(page: Page) {
  return page
    .getByRole("button", { name: /^Use th(is|ese) connections?$/ })
    .first();
}

/**
 * Choosing a personal-scope connection prompts a confirmation ("Use this
 * connection for everyone?") because every caller of the tool would then connect
 * as that one owner. Confirm it so the choice applies; non-personal connections
 * don't prompt. Returns whether a confirmation was handled.
 */
async function confirmPersonalCredentialPinIfPrompted(
  page: Page,
): Promise<boolean> {
  const confirmButton = personalPinConfirmButton(page);
  // The dialog mounts asynchronously after the option click commits (React
  // state + portal + entrance animation). `waitFor` actually waits for it —
  // `isVisible({ timeout })` ignores its timeout and reads the current state,
  // which is how a too-early Escape used to cancel a still-mounting dialog.
  // 5s (not 3s): on standard CI runners the prompt can render a beat later.
  const appeared = await confirmButton
    .waitFor({ state: "visible", timeout: 5_000 })
    .then(() => true)
    .catch(() => false);
  if (!appeared) {
    return false;
  }

  // The dialog re-renders while animating in, which can detach the resolved
  // node between visibility check and click. Short per-attempt clicks inside
  // toPass re-resolve the locator each round instead of pinning one stale node
  // for the whole budget; a button that is already gone means the dialog
  // closed, which is the state the toBeHidden assertion accepts.
  await expect(async () => {
    if (await confirmButton.isVisible().catch(() => false)) {
      await confirmButton.click({ timeout: 2_000 });
    }
    await expect(confirmButton).toBeHidden({ timeout: 2_000 });
  }).toPass({ timeout: 15_000 });
  return true;
}

/**
 * Select a static credential in the open assignment dialog: click the option,
 * confirm the personal-pin dialog if it appears, otherwise close the still-open
 * dropdown. Applying the pin (confirm) leaves the edit dialog open for saving,
 * so a trailing Escape only runs when no confirmation was shown.
 */
export async function selectCredentialOption(
  page: Page,
  credentialOption: ReturnType<Page["getByRole"]>,
): Promise<void> {
  const tokenSelectTrigger = page.getByTestId(E2eTestId.TokenSelect).last();
  const confirmButton = personalPinConfirmButton(page);

  // The dialog's capability rows re-render around the connection dropdown, so
  // between asserting the option visible and clicking it the whole dropdown
  // can collapse (select unmount/remount) — the old forced click then waited
  // out its full timeout on a node that no longer existed. Re-resolve state
  // each attempt: a visible pin-confirm dialog means a previous click already
  // committed; a missing option means the dropdown collapsed and needs
  // reopening via its trigger.
  await expect(async () => {
    if (await confirmButton.isVisible().catch(() => false)) {
      return;
    }
    if (!(await credentialOption.isVisible().catch(() => false))) {
      await tokenSelectTrigger.click({ timeout: 2_000 });
      await expect(credentialOption).toBeVisible({ timeout: 2_000 });
    }
    await credentialOption.click({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });

  const confirmed = await confirmPersonalCredentialPinIfPrompted(page);
  // Close the dropdown only when it is demonstrably still open — a blind
  // Escape after the dropdown already closed dismisses the edit dialog.
  if (!confirmed && (await credentialOption.isVisible().catch(() => false))) {
    await page.keyboard.press("Escape");
  }
  await page.waitForTimeout(200);
}

export async function assignCatalogCredentialToGateway(params: {
  page: Page;
  catalogItemName: string;
  credentialName: string;
  gatewayName: string;
}): Promise<void> {
  await openGatewayCatalogToolAssignment({
    page: params.page,
    catalogItemName: params.catalogItemName,
    gatewayName: params.gatewayName,
  });
  const credentialOption = params.page.getByRole("option", {
    name: params.credentialName,
  });
  // 30s, not 10s: the option list renders from a query result that can
  // transiently miss a just-created credential until the mount-time refetch
  // lands; the options re-render in place once fresh data arrives.
  await expect(credentialOption).toBeVisible({ timeout: 30_000 });
  await selectCredentialOption(params.page, credentialOption);
  await saveOpenProfileDialog(params.page);
}

async function openCatalogToolAssignment({
  page,
  targetName,
  catalogItemName,
  pagePath,
  dialogTitle,
}: AssignmentTarget): Promise<void> {
  await goToPage(page, `${pagePath}?name=${encodeURIComponent(targetName)}`);
  await page.waitForLoadState("domcontentloaded");

  const editButton = page.getByTestId(
    `${E2eTestId.EditAgentButton}-${targetName}`,
  );
  await expect(editButton).toBeVisible({ timeout: 30_000 });
  await editButton.click();

  // Anchor the dialog by its visible heading, not its accessible name: the
  // dialog's aria-labelledby wiring breaks when the title re-renders after
  // the gateway data loads (captured in a failure's ARIA snapshot — the
  // dialog node ends up with an EMPTY accessible name), after which every
  // name-scoped lookup dead-ends. Fast machines finish the flow before that
  // re-render; standard CI runners do not. The broken accessible name is a
  // real product a11y bug — screen readers lose the dialog title the same
  // way — tracked separately from this locator hardening.
  const dialog = page
    .getByRole("dialog")
    .filter({ has: page.getByRole("heading", { name: dialogTitle }) })
    .first();
  await expect(dialog).toBeVisible({ timeout: 15_000 });

  const toolsSectionAnchor = dialog.getByTestId(E2eTestId.AgentToolsSection);
  await toolsSectionAnchor.scrollIntoViewIfNeeded();

  const toolsSectionHeading = dialog.getByRole("heading", {
    name: "Tools & Knowledge Sources",
  });
  await expect(toolsSectionHeading).toBeVisible({ timeout: 10_000 });

  const addButton = dialog.getByTestId(E2eTestId.AgentToolsAddButton);
  await expect(addButton).toBeVisible({ timeout: 10_000 });
  await addButton.click();

  const searchInput = page.getByTestId(
    getAssignmentComboboxSearchInputTestId(E2eTestId.AgentToolsAddButton),
  );
  const visibleTokenSelect = page.getByTestId(E2eTestId.TokenSelect).last();
  const pillButtonByTestId = page.getByTestId(
    getAgentToolCatalogPillTestId(catalogItemName),
  );
  const pillButtonByRole = page.getByRole("button", {
    name: new RegExp(escapeRegExp(catalogItemName)),
  });

  await expect(searchInput).toBeVisible({ timeout: 10_000 });
  await searchInput.fill(catalogItemName);

  const enabledCatalogItem = page.getByTestId(
    getAssignmentComboboxOptionTestId(
      E2eTestId.AgentToolsAddButton,
      catalogItemName,
    ),
  );
  const disabledCatalogItem = page.getByTestId(
    getAssignmentComboboxDisabledOptionTestId(
      E2eTestId.AgentToolsAddButton,
      catalogItemName,
    ),
  );

  type CatalogAssignmentState =
    | "token-select"
    | "pill-testid"
    | "pill-role"
    | "enabled"
    | "disabled"
    | "missing";
  // Widen the literal initializer to the full union: TS narrows `let` vars
  // initialized with a literal to that literal type and does not widen the
  // narrowing when the variable is mutated only through a captured closure
  // (like the expect.poll callback below). Casting the initializer prevents
  // narrowing from the start so subsequent comparisons type-check correctly.
  let catalogAssignmentState = "missing" as CatalogAssignmentState;

  await expect
    .poll(
      async () => {
        if (await visibleTokenSelect.isVisible().catch(() => false)) {
          catalogAssignmentState = "token-select";
          return catalogAssignmentState;
        }
        if (await pillButtonByTestId.isVisible().catch(() => false)) {
          catalogAssignmentState = "pill-testid";
          return catalogAssignmentState;
        }
        if (await pillButtonByRole.isVisible().catch(() => false)) {
          catalogAssignmentState = "pill-role";
          return catalogAssignmentState;
        }
        if (await enabledCatalogItem.isVisible().catch(() => false)) {
          catalogAssignmentState = "enabled";
          return catalogAssignmentState;
        }
        if (await disabledCatalogItem.isVisible().catch(() => false)) {
          catalogAssignmentState = "disabled";
          return catalogAssignmentState;
        }
        catalogAssignmentState = "missing";
        return catalogAssignmentState;
      },
      { timeout: 30_000, intervals: [500, 1000, 2000] },
    )
    .not.toBe("missing");

  if (catalogAssignmentState === "enabled") {
    await enabledCatalogItem.click();
    // Clicking the catalog item opens the per-server tool-config MODAL
    // (item-name heading, "Connect on behalf of" credential select, tool
    // checkboxes) layered over the edit dialog. While it is up, everything
    // beneath is unclickable even though isVisible() still reports the
    // combobox — so only dismiss a leftover combobox when no modal
    // appeared, and do it with a neutral in-dialog click (Escape is banned
    // here: it lands on whatever the CURRENT top layer is, and closing the
    // modal or the edit dialog by accident strands every later step).
    const modalAppeared = await visibleTokenSelect
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (!modalAppeared && (await searchInput.isVisible().catch(() => false))) {
      await toolsSectionHeading.click();
    }
  }

  try {
    await expect(visibleTokenSelect).toBeVisible({ timeout: 15_000 });
  } catch {
    await expect
      .poll(
        async () => {
          if (await visibleTokenSelect.isVisible().catch(() => false)) {
            return "token-select";
          }
          if (await pillButtonByTestId.isVisible().catch(() => false)) {
            return "pill-testid";
          }
          if (await pillButtonByRole.isVisible().catch(() => false)) {
            return "pill-role";
          }
          return "missing";
        },
        { timeout: 20_000, intervals: [500, 1000, 2000, 4000] },
      )
      .not.toBe("missing");

    if (await pillButtonByTestId.isVisible().catch(() => false)) {
      await pillButtonByTestId.click({ force: true });
    } else if (await pillButtonByRole.isVisible().catch(() => false)) {
      await pillButtonByRole.click({ force: true });
    }

    await expect(visibleTokenSelect).toBeVisible({ timeout: 15_000 });
  }

  // Surrounding capability rows re-render briefly when the catalog selection
  // commits — a single click can land on a node that detaches mid-action and
  // silently open nothing. Retry until the dropdown is verifiably open,
  // probing for the always-present "Resolve at call time" option (unique to
  // this dropdown — the tools combobox also renders role=option items).
  // No Escape anywhere in this loop (see the comment above): a still-open
  // combobox just swallows the first trigger click as its outside-dismiss,
  // and the next retry's click then opens the dropdown.
  const dynamicCredentialOption = page
    .getByRole("option", { name: /Resolve at call time/ })
    .first();
  await expect(async () => {
    if (await dynamicCredentialOption.isVisible().catch(() => false)) {
      return;
    }
    // The credential select lives in the tool-config modal; if the modal
    // got dismissed along the way, clicking the assigned server's pill
    // reopens it.
    if (!(await visibleTokenSelect.isVisible().catch(() => false))) {
      if (await pillButtonByTestId.isVisible().catch(() => false)) {
        await pillButtonByTestId.click();
      } else if (await pillButtonByRole.isVisible().catch(() => false)) {
        await pillButtonByRole.click();
      }
    }
    await visibleTokenSelect.click({ timeout: 2_000 });
    await expect(dynamicCredentialOption).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
