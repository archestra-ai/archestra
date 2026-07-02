/**
 * Jest-style mock for `next/navigation` (root-level `__mocks__` — the
 * node_modules convention), activated per test file by a bare
 * `vi.mock("next/navigation");`. All hooks are bare `vi.fn()`s — configure
 * via `vi.mocked(useRouter).mockReturnValue(...)`.
 */
import { vi } from "vitest";

export const useRouter = vi.fn();
export const usePathname = vi.fn();
export const useSearchParams = vi.fn();
export const useParams = vi.fn();
export const useSelectedLayoutSegment = vi.fn();
export const useSelectedLayoutSegments = vi.fn();
export const redirect = vi.fn();
export const permanentRedirect = vi.fn();
export const notFound = vi.fn();
