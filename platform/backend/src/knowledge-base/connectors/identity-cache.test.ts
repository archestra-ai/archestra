// SPDX-License-Identifier: LicenseRef-Archestra-Enterprise
// SPDX-FileCopyrightText: 2026 Archestra Inc.

import { vi } from "vitest";
import { describe, expect, test } from "@/test";
import { ConnectorIdentityCache } from "./identity-cache";

vi.mock("@/cache-manager");

describe("ConnectorIdentityCache", () => {
  const credentials = { email: "admin@example.com", apiToken: "tok-a" };

  test("round-trips values including cached negatives", async () => {
    const cache = new ConnectorIdentityCache<string | null>({
      namespace: "test-email",
      host: "https://site.example.com",
      credentials,
    });

    expect(await cache.get("a1")).toBeUndefined();

    await cache.set("a1", "alice@example.com");
    expect(await cache.get("a1")).toBe("alice@example.com");

    // A hidden-email negative is a cached value, NOT a miss.
    await cache.set("a2", null);
    expect(await cache.get("a2")).toBeNull();
    expect(await cache.get("a3")).toBeUndefined();
  });

  test("entries do not leak across hosts or credentials", async () => {
    const cache = new ConnectorIdentityCache<string | null>({
      namespace: "test-email",
      host: "https://site.example.com",
      credentials,
    });
    await cache.set("a1", "alice@example.com");

    const otherCredential = new ConnectorIdentityCache<string | null>({
      namespace: "test-email",
      host: "https://site.example.com",
      credentials: { email: "viewer@example.com", apiToken: "tok-b" },
    });
    expect(await otherCredential.get("a1")).toBeUndefined();

    const otherHost = new ConnectorIdentityCache<string | null>({
      namespace: "test-email",
      host: "https://other.example.com",
      credentials,
    });
    expect(await otherHost.get("a1")).toBeUndefined();

    const sameScope = new ConnectorIdentityCache<string | null>({
      namespace: "test-email",
      host: "https://site.example.com",
      credentials,
    });
    expect(await sameScope.get("a1")).toBe("alice@example.com");
  });
});
