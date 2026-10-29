import { z } from "zod";

/** A tool a thread declared, as OpenAPPA needs it to rule on the thread's calls. */
export const ThreadToolSchema = z.object({
  name: z.string(),
  namespace: z.string().optional(),
  /** The provider tool type; absent for an ordinary client tool. */
  type: z.string().optional(),
  /** The gateway attestation marker the tool's description led with. */
  marker: z.string().optional(),
  /** Original full callable-contract fingerprint, not the hydrated skeleton. */
  contract: z.string().optional(),
});
export type ThreadTool = z.infer<typeof ThreadToolSchema>;

/** A tool call as the client holds it for a thread response. */
export const ThreadCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
});
export type ThreadCall = z.infer<typeof ThreadCallSchema>;
