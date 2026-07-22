import { describe, expect, test } from "vitest";
import { decideReinstallDialog } from "./reinstall-dialog-decision";

describe("decideReinstallDialog", () => {
  test("no prompted fields → plain confirm (nothing to collect)", () => {
    expect(
      decideReinstallDialog({
        hasPromptedFields: false,
        byosCollectsSecrets: false,
        flaggedInstalls: [
          { reinstallRequired: true, reinstallReason: "new-input" },
        ],
      }),
    ).toBe("confirm");
  });

  test("restart-only flags (e.g. docker image bump) → plain confirm; stored credentials are reused", () => {
    expect(
      decideReinstallDialog({
        hasPromptedFields: true,
        byosCollectsSecrets: false,
        flaggedInstalls: [
          { reinstallRequired: true, reinstallReason: "restart" },
        ],
      }),
    ).toBe("confirm");
  });

  test("new-input flag → collect values", () => {
    expect(
      decideReinstallDialog({
        hasPromptedFields: true,
        byosCollectsSecrets: false,
        flaggedInstalls: [
          { reinstallRequired: true, reinstallReason: "new-input" },
        ],
      }),
    ).toBe("collect-input");
  });

  test("mixed reasons → collect values (any owed input wins)", () => {
    expect(
      decideReinstallDialog({
        hasPromptedFields: true,
        byosCollectsSecrets: false,
        flaggedInstalls: [
          { reinstallRequired: true, reinstallReason: "restart" },
          { reinstallRequired: true, reinstallReason: "new-input" },
        ],
      }),
    ).toBe("collect-input");
  });

  test("missing reason on a flagged install → collect values (conservative pre-reason behavior)", () => {
    expect(
      decideReinstallDialog({
        hasPromptedFields: true,
        byosCollectsSecrets: false,
        flaggedInstalls: [{ reinstallRequired: true, reinstallReason: null }],
      }),
    ).toBe("collect-input");
  });

  test("unflagged fallback target → collect values (no reason to trust a skip)", () => {
    expect(
      decideReinstallDialog({
        hasPromptedFields: true,
        byosCollectsSecrets: false,
        flaggedInstalls: [{ reinstallRequired: false, reinstallReason: null }],
      }),
    ).toBe("collect-input");
  });

  test("no targets at all → collect values", () => {
    expect(
      decideReinstallDialog({
        hasPromptedFields: true,
        byosCollectsSecrets: false,
        flaggedInstalls: [],
      }),
    ).toBe("collect-input");
  });

  test("BYOS with secret prompted fields → collect values even for restart-only flags (vault refs are re-supplied every reinstall)", () => {
    expect(
      decideReinstallDialog({
        hasPromptedFields: true,
        byosCollectsSecrets: true,
        flaggedInstalls: [
          { reinstallRequired: true, reinstallReason: "restart" },
        ],
      }),
    ).toBe("collect-input");
  });
});
