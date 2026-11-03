import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database";

export const SelectLocalDeviceSchema = createSelectSchema(
  schema.localDevicesTable,
  {
    platform: z.enum(["darwin", "win32", "linux"]).nullable(),
    arch: z.enum(["arm64", "x64"]).nullable(),
  },
);
export type LocalDevice = z.infer<typeof SelectLocalDeviceSchema>;

export const LocalDeviceStatusSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  platform: z.enum(["darwin", "win32", "linux"]).nullable(),
  arch: z.enum(["arm64", "x64"]).nullable(),
  appVersion: z.string().nullable(),
  createdAt: z.string(),
  lastSeenAt: z.string().nullable(),
  status: z.enum(["pending", "online", "offline", "revoked"]),
});
