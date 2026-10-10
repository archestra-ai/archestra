import type { IncomingMessage } from "node:http";

class IncomingRequestAbortTracker {
  // Error identity records provenance, not a cache of error messages. Weak
  // references let completed requests and their errors be collected normally.
  private readonly abortedErrors = new WeakSet<Error>();

  observe(request: IncomingMessage): void {
    // Run before parser/instrumentation listeners can capture this error.
    request.prependOnceListener("error", (error: Error & { code?: string }) => {
      if (request.aborted && error.code === "ECONNRESET") {
        this.abortedErrors.add(error);
      }
    });
  }

  isAbortedError(error: unknown): boolean {
    return error instanceof Error && this.abortedErrors.has(error);
  }
}

/** Tracks transport errors at the incoming HTTP boundary. */
export const incomingRequestAbortTracker = new IncomingRequestAbortTracker();
