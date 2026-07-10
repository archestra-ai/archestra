import { describe, expect, test } from "vitest";
import { resolveEditorDraftPolicy } from "./environment-policy-draft";

type NetworkPolicy = NonNullable<
  Parameters<typeof resolveEditorDraftPolicy>[0]["policy"]
>;

const restricted: NetworkPolicy = {
  egressMode: "restricted",
  domainPreset: "none",
  allowedDomains: ["api.example.com"],
  allowedCidrs: ["10.0.0.0/8"],
};

describe("resolveEditorDraftPolicy", () => {
  test("an explicit policy is returned as-is in every mode", () => {
    for (const mode of ["create", "edit", "default"] as const) {
      expect(
        resolveEditorDraftPolicy({
          mode,
          policy: restricted,
          orgDefaultPolicy: null,
        }),
      ).toBe(restricted);
    }
  });

  test("create with no policy seeds the locked-down restricted default", () => {
    expect(
      resolveEditorDraftPolicy({
        mode: "create",
        policy: null,
        orgDefaultPolicy: null,
      }),
    ).toMatchObject({ egressMode: "restricted" });
  });

  test("the org-default editor with no policy seeds unrestricted (built-in floor), not restricted", () => {
    expect(
      resolveEditorDraftPolicy({
        mode: "default",
        policy: null,
        orgDefaultPolicy: null,
      }),
    ).toMatchObject({ egressMode: "unrestricted" });
  });

  test("an existing environment with no policy inherits the org default", () => {
    expect(
      resolveEditorDraftPolicy({
        mode: "edit",
        policy: null,
        orgDefaultPolicy: restricted,
      }),
    ).toBe(restricted);
  });

  test("an existing environment with no policy and no org default seeds unrestricted (built-in), not restricted", () => {
    expect(
      resolveEditorDraftPolicy({
        mode: "edit",
        policy: null,
        orgDefaultPolicy: null,
      }),
    ).toMatchObject({ egressMode: "unrestricted" });
  });
});
