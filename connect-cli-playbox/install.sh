#!/bin/sh
# shellcheck shell=dash
# shellcheck disable=SC2039
#
# Archestra unified connect — CLI UX playbox (dry-run only, installs nothing)
# Works both locally and via:
#   curl -LsSf https://raw.githubusercontent.com/archestra-ai/archestra/demo/unified-connect-cli/connect-cli-playbox/install.sh | sh

set -u

RAW_BASE="${ARCHESTRA_PLAYBOX_BASE:-https://raw.githubusercontent.com/archestra-ai/archestra/demo/unified-connect-cli/connect-cli-playbox}"

if ! command -v node >/dev/null 2>&1; then
    printf "✗ Need Node.js (18+) to run this UX playbox.\n" >&2
    exit 1
fi

LOCAL_DIR=""
if [ -n "${0:-}" ] && [ -f "${0}" ]; then
    LOCAL_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
fi

run_playbox() {
    _script="$1"
    shift
    case "${1:-}" in
        ""|-*) set -- connect "$@" ;;
    esac
    if [ ! -t 0 ] && [ -r /dev/tty ]; then
        node "$_script" "$@" </dev/tty
    else
        node "$_script" "$@"
    fi
}

if [ -n "$LOCAL_DIR" ] && [ -f "${LOCAL_DIR}/archestra-playbox.mjs" ]; then
    run_playbox "${LOCAL_DIR}/archestra-playbox.mjs" "$@"
    exit $?
fi

TMP_FILE=$(mktemp "${TMPDIR:-/tmp}/archestra-playbox.XXXXXX.mjs") || exit 1
trap 'rm -f "$TMP_FILE"' EXIT INT TERM

if command -v curl >/dev/null 2>&1; then
    curl -fsSL "${RAW_BASE}/archestra-playbox.mjs" -o "$TMP_FILE" || exit 1
elif command -v wget >/dev/null 2>&1; then
    wget -qO "$TMP_FILE" "${RAW_BASE}/archestra-playbox.mjs" || exit 1
else
    printf "✗ Need curl or wget to fetch the playbox.\n" >&2
    exit 1
fi

run_playbox "$TMP_FILE" "$@"
