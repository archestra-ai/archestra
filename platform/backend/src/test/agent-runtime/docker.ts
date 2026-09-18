import { spawnSync } from "node:child_process";
import path from "node:path";

export const sandboxImage = process.env.ARCHESTRA_TEST_SANDBOX_IMAGE;

/** Real process tests opt in with an image that contains the terminal driver. */
export function runInContainer(
  script: string,
  options: {
    image?: string;
    mountImageHelpers?: boolean;
    timeout?: number;
    user?: string;
  } = {},
) {
  const imageSources = path.resolve(__dirname, "../../../../agent_images");
  return spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "-i",
      "--network=none",
      ...(options.user ? ["--user", options.user] : []),
      "-v",
      `${__dirname}:/tmp/runtime-fixtures:ro`,
      "-v",
      `${imageSources}/runtime:/tmp/runtime-source:ro`,
      ...(options.mountImageHelpers
        ? ["-v", `${imageSources}/bin:/usr/local/bin:ro`]
        : []),
      "--entrypoint=/bin/sh",
      options.image ?? sandboxImage ?? "",
      "-s",
    ],
    {
      encoding: "utf8",
      timeout: options.timeout ?? 25_000,
      input: `set -eu
mkdir -p /tmp/runtime-bin
export PATH="/tmp/runtime-bin:$PATH"
wait_for() {
  attempt=0
  while [ ! -f "$1" ]; do
    attempt=$((attempt + 1))
    [ "$attempt" -lt 100 ] || { echo "Timed out waiting for $1" >&2; exit 99; }
    sleep 0.1
  done
}
wait_for_absent() {
  attempt=0
  while [ -e "$1" ]; do
    attempt=$((attempt + 1))
    [ "$attempt" -lt 100 ] || { echo "Timed out waiting for removal of $1" >&2; exit 99; }
    sleep 0.1
  done
}
assert_fails() {
  expected_status=$1
  shift
  actual_status=0
  "$@" || actual_status=$?
  [ "$actual_status" = "$expected_status" ] || {
    echo "Expected status $expected_status, received $actual_status: $*" >&2
    exit 1
  }
}
${script}`,
    },
  );
}
