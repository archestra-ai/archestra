import type { FileInput, FileInputDescriptor } from "./file-input";

/**
 * Files handed to the gateway's own built-in tools under the MCP File Uploads
 * extension. For these tools the gateway is the server: it validates each
 * FileInput, asks the caller for out-of-band bytes with `upload_required`,
 * takes the upload at its own address, and runs the tool again on the retry.
 *
 * A built-in handler sees this through `context.files`, which only the MCP
 * gateway sets. A handler never answers the protocol itself: it throws a
 * {@link BuiltInFileAnswer}, which the gateway turns into the JSON-RPC answer,
 * the way an elicitation throws to ask for input.
 */

/** Where a built-in tool wants an uploaded file's bytes to go. */
export type BuiltInFileSink = {
  /** A workspace upload ticket minted for this file, resolved by id. */
  kind: "workspace-transfer";
  ticketId: string;
};

/** What a sink reports once it has stored a file. JSON. */
export type BuiltInFileReceipt = Record<string, unknown>;

/** A file argument as the handler gets it from {@link BuiltInFiles.take}. */
export type TakenFile =
  /** Sent inline; the bytes matched the declared size and digest. */
  | { kind: "inline"; input: FileInput; bytes: Buffer }
  /** Uploaded on an earlier leg of this call; the sink already stored it. */
  | { kind: "uploaded"; input: FileInput; receipt: BuiltInFileReceipt }
  /** Has to be uploaded: call {@link BuiltInFiles.requireUpload}. */
  | { kind: "pending"; input: FileInput }
  /** Cannot be taken; the tool must not run. The message is for the caller. */
  | { kind: "refused"; message: string };

export type BuiltInFiles = {
  /** Whether the caller declared the extension, so can send files at all. */
  readonly accepted: boolean;
  /**
   * Validate one file argument and say how it arrives. Throws a
   * {@link BuiltInFileAnswer} for protocol errors: a caller that did not
   * declare the extension, or uploads, gets MissingRequiredClientCapability.
   */
  take(argument: {
    /** The argument's name, for messages. */
    name: string;
    value: unknown;
    descriptor: FileInputDescriptor;
  }): Promise<TakenFile>;
  /**
   * Ask the caller to upload a pending file to `sink`. Always throws: the
   * gateway answers `upload_required`, and the caller's retry runs the tool
   * again, when {@link take} reports the file as uploaded.
   */
  requireUpload(params: {
    input: FileInput;
    sink: BuiltInFileSink;
    /** Epoch ms after which the sink can no longer take the bytes. */
    expiresAt: number;
  }): never;
};

/** A JSON-RPC error the caller's `tools/call` is answered with. */
export type FileCallRpcError = {
  code: number;
  message: string;
  data?: unknown;
};

/** An answer to the caller that is not a tool result. */
export class BuiltInFileAnswer extends Error {
  constructor(
    readonly answer:
      | {
          kind: "upload";
          input: FileInput;
          sink: BuiltInFileSink;
          expiresAt: number;
        }
      | { kind: "error"; error: FileCallRpcError },
  ) {
    super(
      answer.kind === "upload"
        ? "The tool needs a file uploaded"
        : answer.error.message,
    );
    this.name = "BuiltInFileAnswer";
  }
}
