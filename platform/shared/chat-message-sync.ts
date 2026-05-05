export interface IChatMessageForSync {
  id?: string;
}

export function getChatMessagesSyncSignature(
  messages: IChatMessageForSync[],
): string {
  return messages.map((m) => m.id ?? "").join("\u0001");
}

export function getServerMessagesToApplyToChat<
  T extends IChatMessageForSync,
>(params: {
  status: "ready" | "submitted" | "streaming" | "error";
  clientMessages: T[];
  serverMessages: T[];
  allowHardResyncOnReadyPrefixMismatch?: boolean;
}): T[] | null {
  const {
    status,
    clientMessages,
    serverMessages,
    allowHardResyncOnReadyPrefixMismatch = false,
  } = params;

  if (status !== "ready" || serverMessages.length === 0) {
    return null;
  }

  if (clientMessages.length === 0) {
    return serverMessages;
  }

  if (serverMessages.length <= clientMessages.length) {
    return null;
  }

  for (let i = 0; i < clientMessages.length; i++) {
    if (clientMessages[i]?.id !== serverMessages[i]?.id) {
      if (
        allowHardResyncOnReadyPrefixMismatch &&
        serverMessages.length > clientMessages.length
      ) {
        return serverMessages;
      }
      return null;
    }
  }

  return serverMessages;
}
