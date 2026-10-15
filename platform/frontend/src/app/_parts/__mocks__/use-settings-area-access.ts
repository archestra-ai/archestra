/**
 * Jest-style mock for `@/app/_parts/use-settings-area-access`, activated per
 * test file by a bare `vi.mock("@/app/_parts/use-settings-area-access");`.
 * The reader can see Settings unless a test says otherwise via
 * `vi.mocked(useSettingsAreaAccess).mockReturnValue(false)`. The page map
 * follows it, so the reader's Credentials page (`useCredentialsPage`)
 * resolves to Settings exactly when Settings is visible.
 */
import { vi } from "vitest";

export const useSettingsAreaAccess = vi.fn((): boolean | null => true);
export const useNavPermissionMap = vi.fn((): Record<string, boolean> | null => {
  const canSeeSettings = useSettingsAreaAccess();
  return canSeeSettings === null
    ? null
    : {
        "/settings": canSeeSettings,
        "/settings/credentials": canSeeSettings,
      };
});
