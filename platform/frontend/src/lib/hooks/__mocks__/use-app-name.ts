/**
 * Jest-style mock for `@/lib/hooks/use-app-name`, activated per test file by a bare
 * `vi.mock("@/lib/hooks/use-app-name");`. Every hook is a bare `vi.fn()` — configure per
 * test via `vi.mocked(...)`. Query-key constants stay real (pure data).
 */
import { vi } from "vitest";

const actual = await vi.importActual<typeof import("@/lib/hooks/use-app-name")>(
  "@/lib/hooks/use-app-name",
);

export const DEFAULT_APP_LOGO = actual.DEFAULT_APP_LOGO;

export const useAppName = vi.fn();
export const useAppIconLogo = vi.fn();
