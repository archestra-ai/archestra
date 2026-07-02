// Shared NAPI addon loader. Consumers are the crates' `index.cjs` loaders (plain
// CommonJS); the typed public API of each crate lives in its own generated
// `index.d.ts`, so these signatures are intentionally loose.

export function loadNativeBinding(opts: {
  dir: string;
  crateName: string;
  packageName: string;
}): Record<string, unknown>;

export function wrapSync(
  binding: Record<string, unknown>,
  name: string,
): (...args: unknown[]) => unknown;

export function wrapAsync(
  binding: Record<string, unknown>,
  name: string,
): (...args: unknown[]) => Promise<unknown>;
