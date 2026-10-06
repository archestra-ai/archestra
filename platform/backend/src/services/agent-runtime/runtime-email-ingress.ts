import type { A2AAttachment } from "@/agents/a2a-executor";
import { MAX_EMAIL_BODY_SIZE } from "@/agents/incoming-email/constants";
import { admitEmailTurn } from "@/openappa/native-transport";
import type { OpenAppaSession } from "@/openappa/service";
import { ApiError } from "@/types";

export type RuntimeEmailTurn = {
  messageId: string;
  mailbox: string;
  sourceSenderAddress: string;
  threadId: string;
};

type RuntimeEmailLaunch = {
  task: string;
  attachments: A2AAttachment[];
  /** Set only after a governed admission, for the completion watcher. */
  appaSession: {
    organizationId: string;
    sessionId: string;
    callerId: string;
    parentId?: string;
  } | null;
};

/**
 * Admit the email the runtime is about to see. A refusal throws before any
 * launch. A replacement drops the original attachment bytes.
 */
export async function bindRuntimeEmailLaunch(params: {
  session: OpenAppaSession;
  turn: RuntimeEmailTurn;
  task: string;
  attachments: A2AAttachment[];
  stampSession: boolean;
}): Promise<RuntimeEmailLaunch> {
  if (Buffer.byteLength(params.task, "utf8") > MAX_EMAIL_BODY_SIZE)
    throw new ApiError(413, "The email exceeds the runtime context size bound");
  const admitted = await admitEmailTurn({
    session: {
      organizationId: params.session.organization_id,
      sessionId: params.session.session_id,
      ...(params.session.caller_id
        ? { callerId: params.session.caller_id }
        : {}),
      ...(params.session.parent_id
        ? { parentId: params.session.parent_id }
        : {}),
    },
    messageId: params.turn.messageId,
    mailbox: params.turn.mailbox,
    sourceSenderAddress: params.turn.sourceSenderAddress,
    threadId: params.turn.threadId,
    body: params.task,
    history: [],
    attachments: params.attachments,
  });
  if (admitted.decision === "refused") {
    throw new ApiError(
      409,
      "The email cannot be shown to this runtime session",
    );
  }
  if (admitted.decision === "pass") {
    return {
      task: params.task,
      attachments: params.attachments,
      appaSession: params.stampSession ? stamp(params.session) : null,
    };
  }
  if (Buffer.byteLength(admitted.body, "utf8") > MAX_EMAIL_BODY_SIZE)
    throw new ApiError(
      413,
      "The admitted email exceeds the runtime context size bound",
    );
  return {
    task: admitted.body,
    attachments: admitted.attachments,
    appaSession: stamp(params.session),
  };
}

function stamp(session: OpenAppaSession): RuntimeEmailLaunch["appaSession"] {
  if (!session.caller_id) return null;
  return {
    organizationId: session.organization_id,
    sessionId: session.session_id,
    callerId: session.caller_id,
    ...(session.parent_id ? { parentId: session.parent_id } : {}),
  };
}
