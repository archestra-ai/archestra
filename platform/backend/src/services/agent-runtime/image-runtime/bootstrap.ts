import { createHash } from "node:crypto";
import terminalSource from "../../../../../agent_images/runtime/drivers/tmux.sh";
import legacyStateSource from "../../../../../agent_images/runtime/legacy-tmux-state.sh";
import runtimeSource from "../../../../../agent_images/runtime/runtime.sh";
import selectorSource from "../../../../../agent_images/runtime/select-driver.sh";

const revision = createHash("sha256")
  // Publication changes must also invalidate bundles with unchanged shell assets.
  .update("shell-bundle-v1\0")
  .update(
    [runtimeSource, selectorSource, terminalSource, legacyStateSource].join(
      "\0",
    ),
  )
  .digest("hex");

/**
 * Ordinary calls only ensure an entry point exists. Supervisor startup may
 * activate a new complete bundle after the previous terminal has gone away.
 */
export function buildImageRuntimeInstallScript({
  activate = false,
}: {
  activate?: boolean;
} = {}): string {
  return String.raw`(
set -eu
root="${"$"}{ARCHESTRA_AGENT_RUNTIME_DIR:-/var/run/archestra}"
runtime="$root/runtime"
mkdir -p "$root"
selector=''
if [ -x "$runtime" ]; then
  [ "$("$runtime" describe)" = archestra-image-runtime-v1 ] || { echo 'Unsupported Agent image runtime protocol' >&2; exit 78; }
  ${activate ? ": # Startup activation is allowed only without an owned terminal." : "exit 0"}
  status=0
  "$runtime" ready >/dev/null 2>&1 || status=$?
  case "$status" in
    0) echo 'Cannot activate image runtime while its terminal exists' >&2; exit 78 ;;
    1) ;;
    *) echo 'Cannot establish whether the image runtime terminal exists' >&2; exit 78 ;;
  esac
  selector="$(sed -n '2s/^# archestra-driver: //p' "$runtime")"
  if [ -z "$selector" ]; then
    # Earlier generated facades stored a single shell-quoted driver assignment.
    # Decode that restricted format as data without sourcing the wrapper.
    previous="$(sed -n '2p' "$runtime")"
    case "$previous" in
      "driver='"*"'")
        selector="${"$"}{previous#driver=\'}"
        selector="${"$"}{selector%\'}"
        case "$selector" in *"'"*) echo 'Unrecognized legacy driver selection' >&2; exit 78;; esac
        [ "$selector" != /var/run/archestra/runtime-terminal ] || selector=tmux
        ;;
      *) echo 'Unrecognized image runtime selection; use a new workspace' >&2; exit 78 ;;
    esac
  fi
  if [ "$(sed -n '3s/^# archestra-runtime-revision: //p' "$runtime")" = ${revision} ]; then exit 0; fi
fi
umask 077
bundle="$(mktemp -d "$root/runtime-bundle.XXXXXX")"
published=0
trap '[ "$published" = 1 ] || rm -rf "$bundle"' EXIT
trap 'exit 1' HUP INT TERM
${writeSource("runtime.sh", runtimeSource)}
${writeSource("select-driver.sh", selectorSource)}
${writeSource("tmux.sh", terminalSource)}
${writeSource("legacy-tmux-state.sh", legacyStateSource)}
chmod 700 "$bundle"/*.sh
if [ -z "$selector" ]; then selector="$(/bin/sh "$bundle/select-driver.sh")"; fi
case "$selector" in
  tmux) driver="$bundle/tmux.sh"; bridge="$bundle/legacy-tmux-state.sh" ;;
  /*) driver="$selector"; bridge='' ;;
  *) echo 'Invalid pinned Agent terminal driver selection' >&2; exit 78 ;;
esac
[ -x "$driver" ] || { echo 'Agent terminal driver is not executable' >&2; exit 78; }
[ "$("$driver" describe)" = archestra-terminal-driver-v2 ] || { echo 'Unsupported Agent terminal driver protocol' >&2; exit 78; }
quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
{
  printf '#!/bin/sh\n# archestra-driver: %s\n# archestra-runtime-revision: %s\n' "$selector" '${revision}'
  printf 'exec /bin/sh %s %s %s "$@"\n' "$(quote "$bundle/runtime.sh")" "$(quote "$driver")" "$(quote "$bridge")"
} > "$bundle/entrypoint"
chmod 700 "$bundle/entrypoint"
[ "$("$bundle/entrypoint" describe)" = archestra-image-runtime-v1 ] || exit 78
${
  activate
    ? 'mv "$bundle/entrypoint" "$runtime"\npublished=1'
    : 'if ln "$bundle/entrypoint" "$runtime" 2>/dev/null; then published=1; fi'
}
[ "$("$runtime" describe)" = archestra-image-runtime-v1 ] || { echo 'Unsupported Agent image runtime protocol' >&2; exit 78; }
)`;
}

function writeSource(name: string, source: string): string {
  return `cat > "$bundle/${name}" <<'ARCHESTRA_RUNTIME_SOURCE'\n${source}\nARCHESTRA_RUNTIME_SOURCE`;
}
