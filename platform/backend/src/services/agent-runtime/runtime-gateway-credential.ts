import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import config from "@/config";
import A2ATaskModel from "@/models/a2a/task";
import AgentRunModel from "@/models/agent-run";
import AgentWorkspaceModel from "@/models/agent-workspace";
import MemberModel from "@/models/member";
import ScheduleTriggerRunModel from "@/models/schedule-trigger-run";
import { A2A_TERMINAL_TASK_STATES } from "@/types/a2a-task";

const PREFIX = "rtg1.";
const DOMAIN = "archestra.runtime-gateway.mcp.v1";
const ClaimsSchema = z
  .object({
    scope: z.literal("mcp"),
    background: z.boolean(),
    organizationId: z.string().min(1).max(256),
    userId: z.string().min(1).max(256),
    agentId: z.string().uuid(),
    workspaceId: z.string().uuid(),
    taskId: z.string().uuid(),
    expiresAt: z.number().int().positive(),
  })
  .strict();
type Claims = z.infer<typeof ClaimsSchema>;

/** This bearer carries no personal gateway token and works only on its own MCP gateway. */
export function issueRuntimeGatewayCredential(
  claims: Omit<Claims, "scope" | "background"> & { background?: boolean },
): string {
  if (!config.openappa.offerSigningSecret)
    throw new Error("Runtime gateway credential signer is unavailable");
  const payload = Buffer.from(
    JSON.stringify(
      ClaimsSchema.parse({
        ...claims,
        background: claims.background ?? false,
        scope: "mcp",
      }),
    ),
  ).toString("base64url");
  return `${PREFIX}${payload}.${sign(payload)}`;
}

export function isRuntimeGatewayCredential(token: string): boolean {
  return token.startsWith(PREFIX);
}

/** Resolve origin from the credential itself; caller-selected headers grant no authority. */
export async function resolveRuntimeGatewayCredential(
  token: string,
  agentId: string,
) {
  const claims = read(token);
  if (!claims || claims.agentId !== agentId) return null;
  const [run, workspace, membership, task] = await Promise.all([
    AgentRunModel.findByTaskId(claims.taskId),
    AgentWorkspaceModel.findById(claims.workspaceId),
    MemberModel.getByUserId(claims.userId, claims.organizationId),
    A2ATaskModel.findById(claims.taskId),
  ]);
  if (
    !run ||
    !workspace ||
    !membership ||
    !task ||
    A2A_TERMINAL_TASK_STATES.includes(task.state) ||
    run.endedAt ||
    run.organizationId !== claims.organizationId ||
    run.agentId !== claims.agentId ||
    run.actorKind !== "user" ||
    run.actorId !== claims.userId ||
    run.actorUserId !== claims.userId ||
    workspace.organizationId !== claims.organizationId ||
    workspace.agentId !== claims.agentId ||
    workspace.actorKind !== "user" ||
    workspace.actorId !== claims.userId ||
    workspace.workloadName !== run.workloadName ||
    workspace.activeTaskId !== claims.taskId ||
    workspace.state === "deleting" ||
    workspace.expiresAt.getTime() <= Date.now()
  )
    return null;
  return {
    ...claims,
    isBackgroundExecution:
      claims.background ||
      (await ScheduleTriggerRunModel.isRuntimeTaskScheduled(
        claims.taskId,
        claims.organizationId,
      )),
  };
}

function read(token: string): Claims | null {
  if (
    !isRuntimeGatewayCredential(token) ||
    token.length > 4096 ||
    !config.openappa.offerSigningSecret
  )
    return null;
  const parts = token.slice(PREFIX.length).split(".");
  if (parts.length !== 2) return null;
  const expected = Buffer.from(sign(parts[0]));
  const actual = Buffer.from(parts[1]);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
    return null;
  try {
    const claims = ClaimsSchema.parse(
      JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")),
    );
    return claims.expiresAt > Date.now() ? claims : null;
  } catch {
    return null;
  }
}

function sign(payload: string): string {
  return createHmac("sha256", config.openappa.offerSigningSecret)
    .update(`${DOMAIN}\0${payload}`)
    .digest("base64url");
}
