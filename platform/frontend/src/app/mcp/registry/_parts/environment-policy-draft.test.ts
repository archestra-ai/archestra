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
          policyLoaded: true,
        }),
      ).toBe(restricted);
    }
  });

  test("create with no policy seeds the locked-down restricted default", () => {
    expect(
      resolveEditorDraftPolicy({
        mode: "create",
        policy: null,
        policyLoaded: true,
      }),
    ).toMatchObject({ egressMode: "restricted" });
  });

  test("editing a named environment with no policy seeds restricted, never widening it open", () => {
    expect(
      resolveEditorDraftPolicy({
        mode: "edit",
        policy: null,
        policyLoaded: true,
      }),
    ).toMatchObject({ egressMode: "restricted" });
  });

  test("the org-default editor with a loaded, absent policy seeds unrestricted (built-in floor)", () => {
    expect(
      resolveEditorDraftPolicy({
        mode: "default",
        policy: null,
        policyLoaded: true,
      }),
    ).toMatchObject({ egressMode: "unrestricted" });
  });

  test("the org-default editor whose policy is not yet loaded seeds restricted, not unrestricted", () => {
    // A null policy from an unresolved/failed org query must not seed open egress
    // that a save could persist over a restrictive real default.
    expect(
      resolveEditorDraftPolicy({
        mode: "default",
        policy: null,
        policyLoaded: false,
      }),
    ).toMatchObject({ egressMode: "restricted" });
  });
});
