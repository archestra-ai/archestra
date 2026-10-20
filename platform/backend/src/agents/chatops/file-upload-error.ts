/** Expected messaging-channel configuration/capability failures safe to show to a caller. */
export class ChatOpsFileUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatOpsFileUploadError";
  }
}
