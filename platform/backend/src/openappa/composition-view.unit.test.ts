import { describe, expect, test } from "vitest";
import type {
  BatteryInstall,
  EffectivePolicy,
  ServedComposition,
} from "@/types/openappa-batteries";
import {
  carriedServed,
  compositionView,
  enforcedBattery,
  servedHelperSource,
} from "./composition-view";

const COMPOSED_AT = new Date("2026-10-15T08:00:00.000Z");
const REFUSED_AT = new Date("2026-10-15T09:00:00.000Z");

describe("compositionView", () => {
  test("a clean row is current whatever its record says", () => {
    expect(compositionView(row({ served: null }))).toEqual({
      served: { kind: "current", rootRevision: 4, composedAt: COMPOSED_AT },
      refusal: null,
    });
  });

  test("a refused row serves the composition its record describes", () => {
    expect(
      compositionView(
        row({
          lastError: "policy refused: x",
          lastErrorAt: REFUSED_AT,
          rootRevision: 5,
          served: composition({ rootRevision: 4 }),
        }),
      ),
    ).toEqual({
      served: {
        kind: "previous",
        rootRevision: 4,
        composedAt: COMPOSED_AT,
        batteries: [{ name: "acme", status: "active", composed: true }],
      },
      refusal: {
        message: "policy refused: x",
        at: REFUSED_AT,
        rootRevision: 5,
      },
    });
  });

  test("a record that describes other bytes is not read, so what is served is unknown", () => {
    expect(
      compositionView(
        row({
          lastError: "policy refused: x",
          served: composition({ contentHash: "bytes-another-build-wrote" }),
        }),
      ).served,
    ).toEqual({
      kind: "previous",
      rootRevision: null,
      composedAt: null,
      batteries: null,
    });
  });

  test("a row marked stale reports no refused revision", () => {
    expect(
      compositionView(row({ lastError: "policy refused: x", rootRevision: -1 }))
        .refusal?.rootRevision,
    ).toBeNull();
  });

  test("a root text alone is served only when its record says so", () => {
    expect(
      compositionView(
        row({
          lastError: "policy refused: x",
          served: {
            v: 1,
            kind: "root_only",
            contentHash: HASH,
            rootRevision: 1,
          },
        }),
      ).served,
    ).toEqual({ kind: "root_only" });
  });
});

describe("carriedServed", () => {
  test("a refusal carries the record of the row it replaces", () => {
    const served = composition({ rootRevision: 3 });
    expect(
      carriedServed({ expected: row({ served }), installs: [install()] }),
    ).toBe(served);
  });

  test("a clean row an earlier build stored is described from its rows once", () => {
    expect(
      carriedServed({ expected: row({ served: null }), installs: [install()] }),
    ).toEqual({
      v: 1,
      kind: "composition",
      contentHash: HASH,
      rootRevision: 4,
      composedAt: COMPOSED_AT.toISOString(),
      batteries: [
        {
          entry: null,
          name: "acme",
          status: "active",
          composed: true,
          packageHash: "package-a",
          target: null,
          installId: "install-a",
          credentialBindings: { APPA_PROVIDER_ACME_KEY: "acme-key" },
        },
      ],
    });
  });

  test("rows written after that composition do not stand in for what it composed", () => {
    expect(
      carriedServed({
        expected: row({ served: null }),
        installs: [
          install({ updatedAt: new Date(COMPOSED_AT.getTime() + 1_000) }),
        ],
      }),
    ).toMatchObject({ kind: "composition", rootRevision: 4, batteries: null });
  });

  test("an earlier build's refusal of the root text alone stays the root text alone", () => {
    expect(
      carriedServed({
        expected: row({
          lastError: "policy refused: x",
          served: null,
          content:
            'include = ["batteries/acme/appa.toml"]\n[policy]\nversion = 2\n',
        }),
        installs: [],
      }),
    ).toBeNull();
  });

  test("an earlier build's refusal that kept a composition serves one of unknown revision", () => {
    expect(
      carriedServed({
        expected: row({ lastError: "policy refused: x", served: null }),
        installs: [install()],
      }),
    ).toEqual({
      v: 1,
      kind: "composition",
      contentHash: HASH,
      rootRevision: null,
      composedAt: null,
      batteries: null,
    });
  });
});

describe("enforcedBattery", () => {
  const acme = {
    name: "acme",
    status: "missing_credentials",
    composed: false,
  } as const;

  test("an earlier composition holds a battery at the status it composed with", () => {
    const view = compositionView(
      row({ lastError: "policy refused: x", served: composition({}) }),
    );
    expect(enforcedBattery(view, acme)).toEqual({
      status: "active",
      composed: true,
    });
    expect(
      enforcedBattery(view, { name: "beta", status: "active", composed: true }),
    ).toEqual({ status: "pending", composed: false });
  });

  test("a root text alone holds no battery", () => {
    const view = compositionView(
      row({
        lastError: "policy refused: x",
        served: { v: 1, kind: "root_only", contentHash: HASH, rootRevision: 1 },
      }),
    );
    expect(enforcedBattery(view, acme)).toEqual({
      status: "refused",
      composed: false,
    });
  });
});

describe("servedHelperSource", () => {
  test("only a refused row answers for an install its record names", () => {
    const refused = row({
      lastError: "policy refused: x",
      served: composition({}),
    });
    expect(servedHelperSource(refused, "install-a")).toEqual({
      id: "install-a",
      organizationId: "org-1",
      batteryName: "acme",
      packageHash: "package-a",
      target: null,
      credentialBindings: { APPA_PROVIDER_ACME_KEY: "acme-key" },
    });
    expect(servedHelperSource(refused, "install-b")).toBeNull();
    expect(
      servedHelperSource(row({ served: composition({}) }), "install-a"),
    ).toBeNull();
  });
});

// =============================================================================

const HASH = "content-hash";

function row(overrides: Partial<EffectivePolicy>): EffectivePolicy {
  return {
    organizationId: "org-1",
    content: "[policy]\nversion = 2\n",
    contentHash: HASH,
    rootRevision: 4,
    installFingerprint: "v8:inputs:retired",
    compiledAt: COMPOSED_AT,
    lastError: null,
    lastErrorAt: null,
    served: null,
    retainedAnnotators: null,
    ...overrides,
  };
}

function composition(
  overrides: Partial<Extract<ServedComposition, { kind: "composition" }>>,
): ServedComposition {
  return {
    v: 1,
    kind: "composition",
    contentHash: HASH,
    rootRevision: 4,
    composedAt: COMPOSED_AT.toISOString(),
    batteries: [
      {
        entry: "batteries/acme/appa.toml",
        name: "acme",
        status: "active",
        composed: true,
        packageHash: "package-a",
        target: null,
        installId: "install-a",
        credentialBindings: { APPA_PROVIDER_ACME_KEY: "acme-key" },
      },
    ],
    ...overrides,
  };
}

function install(overrides: Partial<BatteryInstall> = {}): BatteryInstall {
  return {
    id: "install-a",
    organizationId: "org-1",
    batteryName: "acme",
    catalogId: "catalog-a",
    status: "active",
    target: null,
    packageHash: "package-a",
    lastError: null,
    credentialBindings: { APPA_PROVIDER_ACME_KEY: "acme-key" },
    enabled: true,
    createdAt: new Date(COMPOSED_AT.getTime() - 60_000),
    updatedAt: new Date(COMPOSED_AT.getTime() - 60_000),
    ...overrides,
  } as BatteryInstall;
}
