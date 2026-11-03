import { describe, expect, test } from "vitest";
import { breakTheGlassSummary } from "./break-the-glass-summary";

describe("breakTheGlassSummary", () => {
  test("says nothing when every setting still blocks", () => {
    expect(
      breakTheGlassSummary({
        humanApprovalMode: "block",
        unapprovableBlockMode: "refuse",
        breakTheGlassEnabled: false,
      }),
    ).toEqual([]);
  });

  test("names each setting that lets calls through", () => {
    expect(
      breakTheGlassSummary({
        humanApprovalMode: "unattended",
        unapprovableBlockMode: "allow",
        breakTheGlassEnabled: false,
      }),
    ).toEqual([
      { label: "Human approval:", value: "waived in unattended sessions" },
      { label: "Other blocked calls:", value: "waived" },
    ]);
    expect(
      breakTheGlassSummary({
        humanApprovalMode: "everywhere",
        unapprovableBlockMode: "refuse",
        breakTheGlassEnabled: true,
      }),
    ).toEqual([
      { label: "Human approval:", value: "waived everywhere" },
      { label: "Yell:", value: "turns Guardrails off for the session" },
    ]);
  });
});
