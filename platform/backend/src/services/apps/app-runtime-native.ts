// Lazy loader for the `@archestra/app-runtime-rs` native addon (the Rust core
// behind the app envelope, save-time HTML scan, and diagnostics transforms).
//
// Loaded via dynamic import so codegen and any path that never touches an app
// do not require the built `.node` — mirrors the sandbox runtime. The promise is
// memoized, so the addon is resolved at most once per process.

type NativeBindings = typeof import("@archestra/app-runtime-rs");

let nativeBindings: Promise<NativeBindings> | null = null;

export function loadAppRuntimeNative(): Promise<NativeBindings> {
  nativeBindings ??= import("@archestra/app-runtime-rs");
  return nativeBindings;
}
