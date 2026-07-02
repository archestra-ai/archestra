/**
 * Jest-style mock for `sonner` (root-level `__mocks__`), activated per test
 * file by a bare `vi.mock("sonner");`. Assert via
 * `vi.mocked(toast.success)` etc.; `Toaster` renders nothing.
 */
import { vi } from "vitest";

const toastFn = vi.fn() as ReturnType<typeof vi.fn> & Record<string, unknown>;
toastFn.success = vi.fn();
toastFn.error = vi.fn();
toastFn.info = vi.fn();
toastFn.warning = vi.fn();
toastFn.message = vi.fn();
toastFn.loading = vi.fn();
toastFn.promise = vi.fn();
toastFn.dismiss = vi.fn();
toastFn.custom = vi.fn();

export const toast = toastFn;
export const Toaster = vi.fn(() => null);
