import { beforeEach, describe, expect, test, vi } from "vitest";

vi.mock("@/auth", () => ({
  hasAnyAgentTypeAdminPermission: vi.fn(),
}));

import { hasAnyAgentTypeAdminPermission } from "@/auth";
import { resolveA2AUserIsAgentAdmin } from "./a2a";

const mockHasAnyAgentTypeAdminPermission = vi.mocked(
  hasAnyAgentTypeAdminPermission,
);

describe("resolveA2AUserIsAgentAdmin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("preserves full tool access for team or organization tokens", async () => {
    await expect(
      resolveA2AUserIsAgentAdmin({
        tokenUserId: undefined,
        userId: "system",
        organizationId: "org-1",
      }),
    ).resolves.toBe(true);

    expect(mockHasAnyAgentTypeAdminPermission).not.toHaveBeenCalled();
  });

  test("uses the real permission check for user-scoped tokens", async () => {
    mockHasAnyAgentTypeAdminPermission.mockResolvedValueOnce(false);

    await expect(
      resolveA2AUserIsAgentAdmin({
        tokenUserId: "user-1",
        userId: "user-1",
        organizationId: "org-1",
      }),
    ).resolves.toBe(false);

    expect(mockHasAnyAgentTypeAdminPermission).toHaveBeenCalledWith({
      userId: "user-1",
      organizationId: "org-1",
    });
  });
});
