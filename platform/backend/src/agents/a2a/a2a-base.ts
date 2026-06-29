export interface A2AActor {
  id: string;
  kind: "user" | "team" | "organization" | "system";
  organizationId: string;
}

export enum A2AErrorKind {
  InvalidToken,
  UserNotFound,
  TeamNotFound,
  AgentNotFound,
  ContextNotFound,
  InputApprovalFlowIsDisabled,
  OutputApprovalFlowIsDisabled,
  TaskNotFound,
  TaskContextMismatch,
  TaskIsNotInputRequired,
  ApprovalIdNotFound,
  ApprovalIdAlreadyResolved,
  MessageIdAlreadyExists,
  NothingToExecute,
}
const A2A_ERRORS: Record<A2AErrorKind, { code: number; message: string }> = {
  [A2AErrorKind.InvalidToken]: {
    code: -32602,
    message: "Invalid or unauthorized token",
  },
  [A2AErrorKind.UserNotFound]: {
    code: -32602,
    message: "User not found for token",
  },
  [A2AErrorKind.TeamNotFound]: {
    code: -32602,
    message: "Team not found for token",
  },
  [A2AErrorKind.AgentNotFound]: {
    code: -32602,
    message: "Agent not found",
  },
  [A2AErrorKind.ContextNotFound]: {
    code: -32602,
    message: "Context not found",
  },
  [A2AErrorKind.InputApprovalFlowIsDisabled]: {
    code: -32602,
    message: "Approval mode is disabled",
  },
  [A2AErrorKind.OutputApprovalFlowIsDisabled]: {
    code: -32602,
    message: "Some tools require approval, but the approval mode is disabled",
  },
  [A2AErrorKind.TaskNotFound]: {
    code: -32001,
    message: "Task not found",
  },
  [A2AErrorKind.TaskContextMismatch]: {
    code: -32602,
    message: "Task context mismatch",
  },
  [A2AErrorKind.TaskIsNotInputRequired]: {
    code: -32602,
    message: "Task is not in input required state",
  },
  [A2AErrorKind.ApprovalIdNotFound]: {
    code: -32602,
    message: "Approval ID not found",
  },
  [A2AErrorKind.ApprovalIdAlreadyResolved]: {
    code: -32602,
    message: "Approval ID already resolved",
  },
  [A2AErrorKind.MessageIdAlreadyExists]: {
    code: -32602,
    message: "A message with the given ID already exists",
  },
  [A2AErrorKind.NothingToExecute]: {
    code: -32602,
    message: "Nothing to execute",
  },
};

export class A2AError extends Error {
  readonly code: number;
  readonly message: string;
  readonly kind: A2AErrorKind;

  constructor(kind: A2AErrorKind, details?: string) {
    const baseError = A2A_ERRORS[kind];
    super(details ? `${baseError.message}: ${details}` : baseError.message);
    this.code = baseError.code;
    this.message = details
      ? `${baseError.message}: ${details}`
      : baseError.message;
    this.kind = kind;
  }
}
