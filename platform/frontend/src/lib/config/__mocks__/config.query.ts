/**
 * Jest-style mock for `@/lib/config/config.query`, activated per test file by a bare
 * `vi.mock("@/lib/config/config.query");`. Every hook is a bare `vi.fn()` — configure per
 * test via `vi.mocked(...)`. Query-key constants stay real (pure data).
 */
import { vi } from "vitest";

export const useConfig = vi.fn();
export const usePublicConfig = vi.fn();
export const useDisableBasicAuth = vi.fn();
export const useDisableInvitations = vi.fn();
export const usePublicEnterpriseCoreActive = vi.fn();
export const useProviderBaseUrls = vi.fn();
export const useFeature = vi.fn();
export const useEnterpriseFeature = vi.fn();
export const useSmallTeamTier = vi.fn();
export const usePublicBaseUrl = vi.fn();
