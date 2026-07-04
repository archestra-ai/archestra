/**
 * Jest-style mock for `@/lib/teams/team.query`, activated per test file by a bare
 * `vi.mock("@/lib/teams/team.query");`. Every hook is a bare `vi.fn()` — configure per
 * test via `vi.mocked(...)`. Query-key constants stay real (pure data).
 */
import { vi } from "vitest";

export const useTeams = vi.fn();
export const useTeamLabelKeys = vi.fn();
export const useTeamLabelValues = vi.fn();
export const useMyTeams = vi.fn();
export const useAssignableTeams = vi.fn();
export const useTeamsPaginated = vi.fn();
export const useTeamsWithVaultFolders = vi.fn();
