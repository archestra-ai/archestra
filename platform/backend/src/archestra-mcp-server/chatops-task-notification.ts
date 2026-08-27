const TERMINAL_TASK_STATES = new Set([
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_REJECTED",
]);

export function buildChatOpsTaskNotification(params: {
  taskId: string;
  state: string;
  statusReason: string | null;
  output: string;
}): string | null {
  const pullRequestUrl = findPullRequestUrl(params.output);
  if (pullRequestUrl) {
    return `🦀 PR ready: ${pullRequestUrl}`;
  }

  if (!TERMINAL_TASK_STATES.has(params.state)) {
    return null;
  }

  if (params.state === "TASK_STATE_COMPLETED") {
    const output = conciseOutput(params.output);
    return `🦀 Task \`${params.taskId}\` finished.${output ? `\n\n${output}` : ""}`;
  }

  const outcome =
    params.state === "TASK_STATE_CANCELED" ? "was canceled" : "failed";
  const reason = params.statusReason?.trim();
  return `🦀 Task \`${params.taskId}\` ${outcome}.${reason ? ` ${reason}` : ""}`;
}

// === internals ===

function findPullRequestUrl(output: string): string | null {
  const matches = output.match(
    /https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/\d+/g,
  );
  return matches?.at(-1) ?? null;
}

function conciseOutput(output: string): string {
  const cleaned = output
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return (
        trimmed.length > 0 &&
        !trimmed.startsWith("[tool]") &&
        trimmed !== "[waiting for direction]" &&
        !trimmed.startsWith("Archestra background run for ") &&
        !trimmed.startsWith("Model ") &&
        !trimmed.endsWith(" tools available.") &&
        !trimmed.startsWith("Type into this session to steer")
      );
    })
    .join("\n")
    .trim();

  return cleaned.length > 1_000 ? `…${cleaned.slice(-1_000)}` : cleaned;
}
