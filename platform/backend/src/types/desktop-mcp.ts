import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";
import { schema } from "@/database/schema";
import { ConnectionSetupPlatformSchema } from "./connection-setup";

/**
 * Lifecycle of one MCP message waiting for a device.
 * - pending: in the queue, no poll has taken it yet.
 * - dispatched: a poll handed it to the tunnel client.
 * - completed: the tunnel client posted the MCP response.
 */
export const DesktopMcpRequestStatusSchema = z.enum([
  "pending",
  "dispatched",
  "completed",
]);

export type DesktopMcpRequestStatus = z.infer<
  typeof DesktopMcpRequestStatusSchema
>;

/** One JSON-RPC message, stored as it travels through the tunnel. */
export const DesktopMcpJsonRpcMessageSchema = z.record(z.string(), z.unknown());

export type DesktopMcpJsonRpcMessage = z.infer<
  typeof DesktopMcpJsonRpcMessageSchema
>;

const DESKTOP_MCP_COMMAND_MAX_LENGTH = 4096;

/** A command line for a device. `$USER` and `$HOME` are replaced on the device. */
export const DesktopMcpCommandSchema = z
  .string()
  .trim()
  .min(1)
  .max(DESKTOP_MCP_COMMAND_MAX_LENGTH);

/** The URL of an HTTP MCP server that the user runs on the device. */
export const DesktopMcpUrlSchema = z
  .string()
  .trim()
  .max(DESKTOP_MCP_COMMAND_MAX_LENGTH)
  .refine(isHttpUrl, "The URL must start with http:// or https://");

/**
 * What a desktop MCP catalog item tells each device: how to start the MCP
 * server (a command) or where it listens (a URL). An item stored by an older
 * version can also hold `permissions`; parsing drops that key.
 */
export const DesktopMcpConfigSchema = z
  .object({
    command: DesktopMcpCommandSchema.nullish(),
    url: DesktopMcpUrlSchema.nullish(),
  })
  .refine((value) => !(value.command && value.url), {
    message: "Give a command or a URL, not both.",
    path: ["url"],
  });

export type DesktopMcpConfig = z.infer<typeof DesktopMcpConfigSchema>;

/**
 * The state of one MCP server on a device, as the tunnel client reports it.
 * - no_command: the catalog item has no command and no URL.
 * - starting: the process started, or the connection is in progress.
 * - running: the MCP server answered `initialize`.
 * - failed: the last start failed, or the process ended.
 * - stopped: the user stopped it.
 */
export const DesktopMcpServerStateSchema = z.enum([
  "no_command",
  "starting",
  "running",
  "failed",
  "stopped",
]);

export type DesktopMcpServerState = z.infer<typeof DesktopMcpServerStateSchema>;

export const SelectDesktopDeviceSchema = createSelectSchema(
  schema.desktopDevicesTable,
  {
    platform: ConnectionSetupPlatformSchema,
  },
);

export type DesktopDevice = z.infer<typeof SelectDesktopDeviceSchema>;

export const SelectDesktopDeviceServerSchema = createSelectSchema(
  schema.desktopDeviceServersTable,
  { state: DesktopMcpServerStateSchema.nullable() },
);

export type DesktopDeviceServer = z.infer<
  typeof SelectDesktopDeviceServerSchema
>;

export const SelectDesktopMcpRequestSchema = createSelectSchema(
  schema.desktopMcpRequestsTable,
  {
    status: DesktopMcpRequestStatusSchema,
    payload: DesktopMcpJsonRpcMessageSchema,
    response: DesktopMcpJsonRpcMessageSchema.nullable(),
  },
);

export type DesktopMcpRequest = z.infer<typeof SelectDesktopMcpRequestSchema>;

// === Internal helpers

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}
