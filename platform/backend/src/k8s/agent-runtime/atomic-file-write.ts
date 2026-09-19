/** Write stdin to a file without exposing an incomplete destination to readers. */
export function buildAtomicFileWriteCommand(destination: string): string[] {
  return [
    "/bin/sh",
    "-c",
    `set -eu
umask 077
mkdir -p "$(dirname "$1")"
temporary="$(mktemp "$1.tmp.XXXXXX")"
trap 'rm -f "$temporary"' 0
trap 'exit 1' HUP INT TERM
cat > "$temporary"
mv -f "$temporary" "$1"`,
    "atomic-file-write",
    destination,
  ];
}
