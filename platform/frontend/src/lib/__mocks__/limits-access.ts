import { vi } from "vitest";
export const useTeamLimitAccess = vi.fn(() => ({
  teams: [],
  isTeamAdmin: false,
  canRead: false,
  globalCreate: false,
  globalRead: false,
  isPending: false,
  allows: () => false,
  isLocked: () => false,
}));
