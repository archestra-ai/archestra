/** Stable command entry point installed in every managed workspace. */
export const AGENT_IMAGE_RUNTIME = "/var/run/archestra/runtime";

export type ImageRuntimeOperation =
  | "describe"
  | "initialize"
  | "ready"
  | "alive"
  | "inside"
  | "attach"
  | "submit"
  | "capture"
  | "geometry"
  | "retained"
  | "attention"
  | "reset"
  | "launch"
  | "start-recording"
  | "stop"
  | "cancel"
  | "activity"
  | "submit-fifo"
  | "read-result";
