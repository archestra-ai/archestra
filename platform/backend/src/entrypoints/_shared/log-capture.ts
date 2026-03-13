import { Writable } from "node:stream";
import pino from "pino";
import pretty from "pino-pretty";
import { LOG_LEVEL } from "@/logging";

const MAX_LOG_SIZE = 1024 * 1024; // 1 MB

/**
 * Creates a pino logger that simultaneously writes to stdout (pretty-printed)
 * and captures all log output as plain text in a buffer.
 *
 * After the work is done, call `getLogOutput()` to retrieve the captured logs.
 */
export function createCapturingLogger(): {
  logger: pino.Logger;
  getLogOutput: () => string;
} {
  const chunks: string[] = [];
  let totalSize = 0;
  let truncated = false;

  const captureStream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      if (!truncated) {
        const text = chunk.toString();
        totalSize += text.length;
        if (totalSize > MAX_LOG_SIZE) {
          truncated = true;
          chunks.push("\n[logs truncated — exceeded 1 MB]\n");
        } else {
          chunks.push(text);
        }
      }
      callback();
    },
  });

  const prettyStream = pretty({
    colorize: false,
    translateTime: "HH:MM:ss Z",
    ignore: "pid,hostname",
    singleLine: true,
  });

  const prettyStdout = pretty({
    colorize: true,
    translateTime: "HH:MM:ss Z",
    ignore: "pid,hostname",
    singleLine: true,
  });

  // Pipe the capture stream through pretty so we get human-readable logs
  const prettyCaptureStream = new Writable({
    write(chunk: Buffer, encoding, callback) {
      prettyStream.write(chunk, encoding, callback);
    },
  });

  // Forward pretty output to captureStream
  prettyStream.pipe(captureStream);

  const logger = pino(
    { level: LOG_LEVEL },
    pino.multistream([
      { level: "trace", stream: prettyStdout },
      { level: "trace", stream: prettyCaptureStream },
    ]),
  );

  return {
    logger,
    getLogOutput: () => chunks.join(""),
  };
}
