import { describe, expect, test } from "vitest";
import {
  buildEditorNetworkPolicy,
  resolveEditorDraftPolicy,
  resolveNetworkPolicyUpdate,
} from "./environment-policy-draft";

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
          policyLoaded: true,
        }),
      ).toBe(restricted);
    }
  });

  test("create with no policy seeds the locked-down restricted default, ignoring the org default", () => {
    // `restricted` (the org default here) shares egressMode with the create seed,
    // so assert the seed's empty allowlist to prove the org default is not returned.
    expect(
      resolveEditorDraftPolicy({
        mode: "create",
        policy: null,
        orgDefaultPolicy: restricted,
        policyLoaded: true,
      }),
    ).toMatchObject({ egressMode: "restricted", allowedDomains: [] });
  });

  test("a null policy with no org default seeds the built-in unrestricted floor", () => {
    // The org default (its own null) and a named env whose org default is also
    // null both land on the floor — showing "restricted" would falsely read as
    // locked down.
    for (const mode of ["edit", "default"] as const) {
      expect(
        resolveEditorDraftPolicy({
          mode,
          policy: null,
          orgDefaultPolicy: null,
          policyLoaded: true,
        }),
      ).toMatchObject({ egressMode: "unrestricted" });
    }
  });

  test("a null-policy env inheriting a restrictive org default seeds restricted, not unrestricted", () => {
    // The env falls through to the org default, so the editor must show that
    // default's restriction — not the floor, which would under-state it and let a
    // touched save widen the env open.
    expect(
      resolveEditorDraftPolicy({
        mode: "edit",
        policy: null,
        orgDefaultPolicy: restricted,
        policyLoaded: true,
      }),
    ).toBe(restricted);
  });

  test("a null policy whose org query is not yet loaded seeds restricted, not unrestricted", () => {
    // A null from an unresolved/failed org query must not seed open egress that a
    // deliberate touch-then-save during load could persist over a real default.
    for (const mode of ["edit", "default"] as const) {
      expect(
        resolveEditorDraftPolicy({
          mode,
          policy: null,
          orgDefaultPolicy: null,
          policyLoaded: false,
        }),
      ).toMatchObject({ egressMode: "restricted" });
    }
  });
});

describe("buildEditorNetworkPolicy", () => {
  const base = {
    enforcementUnavailable: false,
    egressMode: "restricted" as const,
    domainPreset: "none" as const,
    allowedDomainsText: "",
    allowedCidrsText: "",
    originalPolicy: null,
  };

  test("restricted mode parses the CIDR and domain textareas", () => {
    expect(
      buildEditorNetworkPolicy({
        ...base,
        allowedDomainsText: "api.example.com\n*.registry.example.com",
        allowedCidrsText: "203.0.113.0/24, 2001:db8::/32",
      }),
    ).toEqual({
      egressMode: "restricted",
      domainPreset: "none",
      allowedDomains: ["api.example.com", "*.registry.example.com"],
      allowedCidrs: ["203.0.113.0/24", "2001:db8::/32"],
    });
  });

  test("off/unrestricted modes drop all allowlists", () => {
    for (const egressMode of ["off", "unrestricted"] as const) {
      expect(
        buildEditorNetworkPolicy({
          ...base,
          egressMode,
          allowedCidrsText: "203.0.113.0/24",
          allowedDomainsText: "api.example.com",
        }),
      ).toEqual({
        egressMode,
        domainPreset: "none",
        allowedDomains: [],
        allowedCidrs: [],
      });
    }
  });

  test("a CIDR-only edit keeps the seeded (inherited) domain allowlist even when the env has no policy of its own", () => {
    // With no FQDN provider the domain/preset fields are disabled but still hold
    // the effective policy the editor seeded them with — an env inheriting the org
    // default's domain rules keeps them (originalPolicy is null here), rather than
    // materializing an override that silently drops rules the form can't re-enter.
    expect(
      buildEditorNetworkPolicy({
        ...base,
        domainPreset: "common_dependencies",
        allowedDomainsText: "api.example.com",
        allowedCidrsText: "203.0.113.0/24",
        originalPolicy: null,
      }),
    ).toEqual({
      egressMode: "restricted",
      domainPreset: "common_dependencies",
      allowedDomains: ["api.example.com"],
      allowedCidrs: ["203.0.113.0/24"],
    });
  });

  test("no enforcer keeps the existing policy rather than persisting a deny-all", () => {
    const stored = {
      egressMode: "restricted" as const,
      domainPreset: "none" as const,
      allowedDomains: [],
      allowedCidrs: ["10.0.0.0/8"],
    };
    expect(
      buildEditorNetworkPolicy({
        ...base,
        enforcementUnavailable: true,
        originalPolicy: stored,
      }),
    ).toBe(stored);
  });

  test("no enforcer on a policy-less target seeds a non-enforcing (unrestricted) policy", () => {
    expect(
      buildEditorNetworkPolicy({
        ...base,
        enforcementUnavailable: true,
        originalPolicy: null,
      }),
    ).toMatchObject({ egressMode: "unrestricted" });
  });
});

describe("resolveNetworkPolicyUpdate", () => {
  const drafted: NetworkPolicy = {
    egressMode: "unrestricted",
    domainPreset: "none",
    allowedDomains: [],
    allowedCidrs: [],
  };

  test("create always sends the policy, even when the user never touched egress", () => {
    expect(
      resolveNetworkPolicyUpdate({
        mode: "create",
        egressDirty: false,
        originalPolicy: null,
        orgLoaded: false,
        networkPolicy: drafted,
      }),
    ).toEqual({ networkPolicy: drafted });
  });

  test("an unchanged edit omits networkPolicy so the stored policy is left as-is", () => {
    expect(
      resolveNetworkPolicyUpdate({
        mode: "edit",
        egressDirty: false,
        originalPolicy: null,
        orgLoaded: true,
        networkPolicy: drafted,
      }),
    ).toEqual({});
  });

  test("an unchanged org-default save omits networkPolicy, never widening the built-in floor", () => {
    // The default editor seeds the egress control to `unrestricted` for display;
    // omitting on an untouched save is what stops that seed reaching the backend
    // and clearing a real restrictive default.
    expect(
      resolveNetworkPolicyUpdate({
        mode: "default",
        egressDirty: false,
        originalPolicy: null,
        orgLoaded: true,
        networkPolicy: drafted,
      }),
    ).toEqual({});
  });

  test("a touched edit of an inheriting (null) policy waits for the org baseline to load", () => {
    // While the org query is unresolved the draft is seeded from the locked-down
    // fallback, not the real effective policy, so persisting a dirty edit could
    // widen a narrower real one. Hold it back until the baseline loads, then send.
    for (const mode of ["edit", "default"] as const) {
      expect(
        resolveNetworkPolicyUpdate({
          mode,
          egressDirty: true,
          originalPolicy: null,
          orgLoaded: false,
          networkPolicy: drafted,
        }),
      ).toEqual({});
      expect(
        resolveNetworkPolicyUpdate({
          mode,
          egressDirty: true,
          originalPolicy: null,
          orgLoaded: true,
          networkPolicy: drafted,
        }),
      ).toEqual({ networkPolicy: drafted });
    }
  });

  test("a touched edit of an env's own explicit policy is sent even while the org query is down", () => {
    // An explicit policy is its own baseline — it doesn't inherit — so an
    // unavailable org query must not silently drop the admin's egress change.
    const explicit: NetworkPolicy = {
      egressMode: "restricted",
      domainPreset: "none",
      allowedDomains: [],
      allowedCidrs: ["10.0.0.0/8"],
    };
    expect(
      resolveNetworkPolicyUpdate({
        mode: "edit",
        egressDirty: true,
        originalPolicy: explicit,
        orgLoaded: false,
        networkPolicy: drafted,
      }),
    ).toEqual({ networkPolicy: drafted });
  });
});
