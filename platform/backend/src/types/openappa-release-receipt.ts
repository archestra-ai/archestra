import { z } from "zod";

/**
 * A reference to a value the OpenAPPA runtime admitted: its session, the log
 * position of the admitting fact, and the value's lowercase-hex SHA-256. It
 * carries no label; the runtime reads the label from its own log when it
 * judges a release.
 */
const ReleaseReceiptSchema = z.strictObject({
  session: z.string().min(1),
  factPosition: z.number().int().nonnegative(),
  digest: z.string().regex(/^[0-9a-f]{64}$/),
});
export type ReleaseReceipt = z.infer<typeof ReleaseReceiptSchema>;
