export type CodexShellObservation = {
  outcome: "success" | "failure" | "indeterminate";
  processState: "running" | "exited" | "unknown";
  exitCode?: number;
  localSessionId?: number;
  output?: string;
};

/** Only stock-generated metadata before Output: describes process state. */
export function inspectCodexShellOutput(value: unknown): CodexShellObservation {
  if (typeof value !== "string") return unknownOutcome();
  const match = SHELL_ENVELOPE.exec(value);
  if (!match) return unknownOutcome();
  const exitCode =
    match.groups?.exit === undefined ? undefined : Number(match.groups.exit);
  const localSessionId =
    match.groups?.session === undefined
      ? undefined
      : Number(match.groups.session);
  if (
    (exitCode !== undefined && !isInt32(exitCode)) ||
    (localSessionId !== undefined && !isInt32(localSessionId))
  ) {
    return unknownOutcome();
  }
  if (exitCode === undefined && localSessionId === undefined)
    return unknownOutcome();
  if (exitCode !== undefined && localSessionId !== undefined)
    return unknownOutcome();
  return {
    // Success here means the polling RPC returned, not that a live process exited.
    outcome: exitCode === undefined || exitCode === 0 ? "success" : "failure",
    processState: localSessionId !== undefined ? "running" : "exited",
    exitCode,
    localSessionId,
    output: value.slice(match[0].length),
  };
}

/** The caller must first persist the local/proxy handle association. */
export function rewriteCodexShellHandle(params: {
  output: string;
  expectedLocalId: number;
  proxyId: number;
}): string {
  const parsed = inspectCodexShellOutput(params.output);
  if (
    parsed.localSessionId !== params.expectedLocalId ||
    !isInt32(params.proxyId)
  ) {
    throw new Error(
      "Codex process handle does not match its recorded association",
    );
  }
  const match = SHELL_ENVELOPE.exec(params.output);
  if (!match) throw new Error("Codex shell wrapper is not recognized");
  return (
    match[0].replace(
      /^Process running with session ID -?\d+$/m,
      `Process running with session ID ${params.proxyId}`,
    ) + params.output.slice(match[0].length)
  );
}

function unknownOutcome(): CodexShellObservation {
  return { outcome: "indeterminate", processState: "unknown" };
}

function isInt32(value: number) {
  return (
    Number.isInteger(value) && value >= -2_147_483_648 && value <= 2_147_483_647
  );
}

const SHELL_ENVELOPE =
  /^(?:Chunk ID: [0-9a-f]{6}\n)?Wall time: \d+(?:\.\d+)? seconds\n(?:Process exited with code (?<exit>-?\d+)\n)?(?:Process running with session ID (?<session>-?\d+)\n)?(?:Original token count: \d+\n)?Output:\n/;
