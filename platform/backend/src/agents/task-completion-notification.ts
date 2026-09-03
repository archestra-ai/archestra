const TERMINAL_TASK_STATES = new Set([
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED",
]);

export function buildTaskCompletionNotification(params: {
  state: string;
  statusReason: string | null;
  output: string;
}): string | null {
  if (!TERMINAL_TASK_STATES.has(params.state)) {
    return null;
  }

  if (params.state === "TASK_STATE_COMPLETED") {
    const pullRequestUrl = findPullRequestUrl(params.output);
    if (pullRequestUrl) {
      return `PR ready: ${pullRequestUrl}`;
    }

    const output = conciseOutput(params.output);
    return output || "Task finished.";
  }

  const outcome =
    params.state === "TASK_STATE_CANCELED" ? "was canceled" : "failed";
  const reason = params.statusReason?.trim();
  return `Task ${outcome}.${reason ? ` ${reason}` : ""}`;
}

// === Internal helpers ===

function findPullRequestUrl(output: string): string | null {
  const matches = output.match(
    /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/g,
  );
  return matches?.at(-1) ?? null;
}

function conciseOutput(output: string): string {
  // Native catalog clients write their complete interactive transcript to the
  // execution log. That belongs in the execution console, not in a completion
  // message. PR links are extracted above before this guard.
  if (
    output.includes("[archestra] agent session exited") ||
    looksLikeTerminalControlStream(output)
  ) {
    return "";
  }

  const cleaned = output
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return (
        trimmed.length > 0 &&
        !trimmed.startsWith("[tool]") &&
        trimmed !== "[waiting for direction]" &&
        !trimmed.startsWith("Agent Runtime run for ") &&
        !trimmed.startsWith("Model ") &&
        !trimmed.endsWith(" tools available.") &&
        !trimmed.startsWith("Type into this session to steer")
      );
    })
    .join("\n")
    .trim();

  return cleaned.length > 1_000 ? `…${cleaned.slice(-1_000)}` : cleaned;
}

function looksLikeTerminalControlStream(output: string): boolean {
  const escapeCharacter = String.fromCharCode(27);
  const controlSequenceIntroducer = String.fromCharCode(155);
  if (
    output.includes(`${escapeCharacter}[`) ||
    output.includes(controlSequenceIntroducer)
  ) {
    return true;
  }

  // Some transcript transports drop the escape byte while preserving the CSI
  // payload. Repeated cursor/style commands are still enough to identify a TUI
  // redraw, without rejecting ordinary prose containing square brackets.
  const bareControlSequences = output.match(
    /\[(?:\?[0-9;:]*|[0-9;:]+)[ -/]*[@-~]/g,
  );
  return (bareControlSequences?.length ?? 0) >= 3;
}
