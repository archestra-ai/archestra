// Downscale/re-encode an image so it fits a model's inline-image limits, via
// the native Rust shrinker (off the JS thread, with a bounded decoder). Any
// failure — unsupported format, decode-limit hit, missing native addon —
// resolves to null so callers fall back to reporting the file as undelivered.

import logger from "@/logging";

// Lazy, memoized load of the native addon: codegen and paths that never shrink
// an image don't require the built `.node`. Mirrors the sandbox/app-runtime
// native loaders.
type ImageRsBindings = typeof import("@archestra/image-rs");
let nativeBindings: Promise<ImageRsBindings> | null = null;
function loadImageRsNative(): Promise<ImageRsBindings> {
  nativeBindings ??= import("@archestra/image-rs");
  return nativeBindings;
}

export async function shrinkImageForModel(
  buffer: Buffer,
  targets: { maxBytes: number; maxDimension: number },
): Promise<{ buffer: Buffer; contentType: string } | null> {
  try {
    const native = await loadImageRsNative();
    const result = await native.shrinkImageToFit(
      buffer,
      targets.maxBytes,
      targets.maxDimension,
    );
    if (!result) return null;
    return { buffer: result.bytes, contentType: result.contentType };
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      "[image-conversion] failed to shrink image",
    );
    return null;
  }
}
