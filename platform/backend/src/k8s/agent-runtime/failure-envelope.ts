/** Runtime-owned messages are serialized here so custom images need no JSON tool. */
export function buildRuntimeFailureEnvelopeScript({
  prefixVariable,
  code,
  message,
}: {
  prefixVariable: "turn" | "ARCHESTRA_AGENT_RUNTIME_TURN_PREFIX";
  code: string;
  message: string;
}): string {
  const envelope = JSON.stringify({ version: 1, code, message }).replaceAll(
    "'",
    "'\\''",
  );
  // Publish before the exit marker; reporting failure must never change the
  // original exit status. Only caller-owned static text belongs in this file.
  return `(
  umask 077
  failure_prefix="\${${prefixVariable}:-}"
  [ -n "$failure_prefix" ] || exit 0
  failure_temporary="$failure_prefix.failure.tmp.$$"
  if printf '%s\\n' '${envelope}' > "$failure_temporary"; then
    mv "$failure_temporary" "$failure_prefix.failure" || true
  fi
  rm -f "$failure_temporary" || true
) 2>/dev/null || true`;
}
