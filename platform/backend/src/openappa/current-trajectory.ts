import { z } from "zod";

/** Proxy-written execution identity, never selected by model arguments. */
export const CurrentTrajectorySchema = z.strictObject({
  v: z.literal(1),
  session_id: z.string().min(1),
  parent_id: z.string().min(1).optional(),
});

export function currentTrajectory(session: {
  session_id: string;
  parent_id?: string;
}): z.infer<typeof CurrentTrajectorySchema> {
  return {
    v: 1,
    session_id: session.session_id,
    ...(session.parent_id ? { parent_id: session.parent_id } : {}),
  };
}

export function parseCurrentTrajectory(
  value: unknown,
): z.infer<typeof CurrentTrajectorySchema> | undefined {
  const parsed = CurrentTrajectorySchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}
