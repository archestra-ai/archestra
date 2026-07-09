/**
 * Raised when a delegation would re-enter an agent already on the caller's
 * ancestor path, or would exceed the delegation depth ceiling. Lives outside
 * `a2a-executor` so the delegation tool can recognize it without importing a
 * module that most agent tests replace with a mock.
 */
export class DelegationLoopError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DelegationLoopError";
  }
}
