import { buildImageRuntimeInstallScript } from "./bootstrap";
import { AGENT_IMAGE_RUNTIME, type ImageRuntimeOperation } from "./contract";

/** Ensure the workspace entry point exists, then pass arguments without interpolation. */
export function imageRuntimeCommand(
  operation: ImageRuntimeOperation,
  ...args: string[]
): string[] {
  return [
    "/bin/sh",
    "-c",
    `set -e\n${buildImageRuntimeInstallScript()}\nexec ${AGENT_IMAGE_RUNTIME} "$@"`,
    "image-runtime",
    operation,
    ...args,
  ];
}
