import { ARCHESTRA_TOKEN_PREFIX } from "@shared";
import { describe, expect, it } from "vitest";
import { shouldSkipCreateApiKeySubmit } from "./page.utils";

describe("shouldSkipCreateApiKeySubmit", () => {
  it("allows submission for a fresh dialog state", () => {
    expect(
      shouldSkipCreateApiKeySubmit({
        hasSubmittedForCurrentDialogOpen: false,
        isCreatePending: false,
        createdApiKeyValue: null,
      }),
    ).toBe(false);
  });

  it("blocks submission when a create is already in flight", () => {
    expect(
      shouldSkipCreateApiKeySubmit({
        hasSubmittedForCurrentDialogOpen: false,
        isCreatePending: true,
        createdApiKeyValue: null,
      }),
    ).toBe(true);
  });

  it("blocks submission after the dialog has already created a key", () => {
    expect(
      shouldSkipCreateApiKeySubmit({
        hasSubmittedForCurrentDialogOpen: true,
        isCreatePending: false,
        createdApiKeyValue: `${ARCHESTRA_TOKEN_PREFIX}123`,
      }),
    ).toBe(true);
  });
});
