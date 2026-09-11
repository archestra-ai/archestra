import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { TokenAuthContext } from "@/clients/mcp-client";

// These names are reserved to the gateway. They intentionally do not join the
// Archestra built-in registry: APPA controls are capability-scoped, not assignable
// agent tools, and must never be reached through run_tool or upstream dispatch.
export const APPA_CONTROL_TOOL_NAMES = {
  inspectPlan: "archestra__appa_inspect_plan",
  executeRemedy: "archestra__appa_execute_remedy",
  status: "archestra__appa_status",
} as const;

export type AppaControlPrincipal = {
  organizationId: string;
  gatewayProfileId: string;
  subject: { kind: "user" | "gateway_token"; id: string };
};

/**
 * Opaque capability issued and verified by the durable APPA control service.
 * The gateway never derives this from model arguments or HTTP headers.
 */
export type AppaControlSession = {
  id: string;
};

/**
 * Opaque correlation IDs transported by an MCP client. They are never an
 * authentication source: the durable service may use them only to vouch an
 * already proxy-issued control call against its own intent binding.
 */
export type AppaWireContext = {
  callId?: string;
  threadId?: string;
  itemId?: string;
};

export type AppaControlResponse = {
  state: "complete" | "pending" | "rejected";
  result: Record<string, unknown>;
};

export type AppaHumanReviewRequired = {
  state: "human_review_required";
  elicitation: {
    message: string;
    requestedSchema: Record<string, unknown>;
  };
};

export type AppaControlOperationResponse =
  | AppaControlResponse
  | AppaHumanReviewRequired;

/**
 * Durable APPA control-plane boundary. Its implementation owns all intent
 * bindings (organization, caller, gateway profile, turn, batch, and position)
 * and is supplied by the parent integration. This gateway layer owns no
 * authoritative APPA state.
 */
export interface AppaControlService {
  /**
   * Returns a capability only for an enabled, authenticated profile session.
   * Returning null makes the APPA surface invisible and non-callable.
   */
  authorizeControlSession(params: {
    principal: AppaControlPrincipal;
  }): Promise<AppaControlSession | null>;
  inspectPlan(params: {
    principal: AppaControlPrincipal;
    controlSession: AppaControlSession;
    wireContext: AppaWireContext;
    intentId: string;
  }): Promise<AppaControlResponse>;
  executeSelectedNonHumanRemedy(params: {
    principal: AppaControlPrincipal;
    controlSession: AppaControlSession;
    wireContext: AppaWireContext;
    intentId: string;
    remedyId: string;
  }): Promise<AppaControlOperationResponse>;
  getStatus(params: {
    principal: AppaControlPrincipal;
    controlSession: AppaControlSession;
    wireContext: AppaWireContext;
    intentId: string;
  }): Promise<AppaControlResponse>;
  /**
   * Records an MCP elicitation response only after the implementation has
   * matched it to its durable request binding. This response is untrusted: it
   * must never itself prove execution approval or human identity. A separate
   * trusted callback owned by the implementation is the only path that may
   * resolve a human decision.
   */
  recordUntrustedMcpElicitationResponse(params: {
    principal: AppaControlPrincipal;
    controlSession: AppaControlSession;
    wireContext: AppaWireContext;
    intentId: string;
    remedyId: string;
    /** Signed and verified by the gateway before this service is called. */
    verifiedRequestState: string;
    response: unknown;
  }): Promise<AppaControlResponse>;
}

/**
 * Optional process-composition hook for the public MCP gateway. A provider may
 * return one global service or select a service by authenticated profile. It
 * must not authorize from client metadata; authorization remains entirely in
 * `authorizeControlSession`.
 */
export type AppaControlServiceProvider = (params: {
  profileId: string;
  tokenAuth: TokenAuthContext;
}) => AppaControlService | undefined;

type AppaControlToolName =
  (typeof APPA_CONTROL_TOOL_NAMES)[keyof typeof APPA_CONTROL_TOOL_NAMES];

type AppaControlDispatch =
  | { kind: "result"; result: CallToolResult }
  | {
      kind: "input_required";
      request: {
        method: "elicitation/create";
        params: Record<string, unknown>;
      };
    };

const OpaqueIntentIdSchema = z
  .string()
  .min(1)
  .max(256)
  .describe(
    "Opaque APPA intent ID. The service resolves its server-owned binding.",
  );
const OpaqueRemedyIdSchema = z
  .string()
  .min(1)
  .max(256)
  .describe("Opaque selected remedy ID from the inspected APPA plan.");
const OpaqueWireIdSchema = z.string().min(1).max(512);
const WireContextArgsSchema = z.strictObject({
  call_id: OpaqueWireIdSchema,
  thread_id: OpaqueWireIdSchema,
  item_id: OpaqueWireIdSchema.optional(),
});

const InspectPlanArgsSchema = z
  .strictObject({
    intent_id: OpaqueIntentIdSchema,
    wire_context: WireContextArgsSchema.optional(),
  })
  .describe("Inspect the server-owned APPA remedy plan for one intent.");
const ExecuteRemedyArgsSchema = z
  .strictObject({
    intent_id: OpaqueIntentIdSchema,
    remedy_id: OpaqueRemedyIdSchema,
    wire_context: WireContextArgsSchema.optional(),
  })
  .describe("Execute one selected non-human APPA remedy.");
const StatusArgsSchema = z
  .strictObject({
    intent_id: OpaqueIntentIdSchema,
    wire_context: WireContextArgsSchema.optional(),
  })
  .describe("Read APPA remedy status for one intent.");

const APPA_CONTROL_TOOLS: Tool[] = [
  createTool({
    name: APPA_CONTROL_TOOL_NAMES.inspectPlan,
    title: "Inspect APPA Plan",
    description:
      "Inspect the server-owned APPA remedy plan for an intent. This never grants approval authority.",
    schema: InspectPlanArgsSchema,
  }),
  createTool({
    name: APPA_CONTROL_TOOL_NAMES.executeRemedy,
    title: "Execute APPA Remedy",
    description:
      "Execute a selected non-human APPA remedy. Human-required remedies are never approved by this tool.",
    schema: ExecuteRemedyArgsSchema,
  }),
  createTool({
    name: APPA_CONTROL_TOOL_NAMES.status,
    title: "APPA Remedy Status",
    description: "Read current APPA remedy status for an intent.",
    schema: StatusArgsSchema,
  }),
];

let appaControlServiceProvider: AppaControlServiceProvider | undefined;

// === Exports ===

export function isAppaControlToolName(
  name: string,
): name is AppaControlToolName {
  return Object.values(APPA_CONTROL_TOOL_NAMES).includes(
    name as AppaControlToolName,
  );
}

export function isReservedAppaControlToolName(name: string): boolean {
  return name.startsWith("archestra__appa_");
}

/**
 * Exact composition hook for the normal `/v1/mcp/:profileId` route. It is
 * unset by default, leaving APPA controls unavailable until the parent
 * integration installs its durable provider.
 */
export function setAppaControlServiceProvider(
  provider: AppaControlServiceProvider | undefined,
): void {
  appaControlServiceProvider = provider;
}

export function resolveAppaControlService(params: {
  profileId: string;
  tokenAuth: TokenAuthContext;
}): AppaControlService | undefined {
  return appaControlServiceProvider?.(params);
}

/**
 * Merges client metadata with an optional server-emitted locator tuple. Neither
 * source grants authority: the durable service verifies every value against its
 * sealed control frame before acting. A disagreement is rejected, never fixed
 * up by overwriting metadata from the other source.
 */
export function normalizeAppaWireContext(params: {
  metadata: AppaWireContext;
  wireContext?: z.infer<typeof WireContextArgsSchema>;
}): AppaWireContext | null {
  if (!params.wireContext) return params.metadata;
  const argumentContext: AppaWireContext = {
    callId: params.wireContext.call_id,
    threadId: params.wireContext.thread_id,
    ...(params.wireContext.item_id && { itemId: params.wireContext.item_id }),
  };
  for (const key of ["callId", "threadId", "itemId"] as const) {
    if (
      params.metadata[key] !== undefined &&
      params.metadata[key] !== argumentContext[key]
    ) {
      return null;
    }
  }
  return { ...argumentContext, ...params.metadata };
}

/**
 * Returns APPA controls only after the durable service authorizes this exact
 * token-derived principal and gateway profile. With no service, the default is
 * deliberately empty.
 */
export async function getAppaControlTools(params: {
  service: AppaControlService | undefined;
  profileId: string;
  tokenAuth: TokenAuthContext | undefined;
}): Promise<Tool[]> {
  const principal = deriveAppaControlPrincipal({
    profileId: params.profileId,
    tokenAuth: params.tokenAuth,
  });
  if (!principal || !params.service) return [];

  const session = await params.service.authorizeControlSession({ principal });
  return session ? APPA_CONTROL_TOOLS : [];
}

/**
 * Executes APPA controls exclusively through the injected service. It does not
 * fall through to built-ins or an upstream MCP server when authorization fails.
 */
export async function dispatchAppaControlTool(params: {
  service: AppaControlService | undefined;
  profileId: string;
  tokenAuth: TokenAuthContext | undefined;
  toolName: string;
  args: Record<string, unknown> | undefined;
  wireContext: AppaWireContext;
  elicitationResponse?: unknown;
  verifiedRequestState?: string;
}): Promise<AppaControlDispatch> {
  const principal = deriveAppaControlPrincipal({
    profileId: params.profileId,
    tokenAuth: params.tokenAuth,
  });
  if (!principal || !params.service) {
    return { kind: "result", result: unavailableResult() };
  }

  const controlSession = await params.service.authorizeControlSession({
    principal,
  });
  if (!controlSession) {
    return { kind: "result", result: unavailableResult() };
  }

  switch (params.toolName) {
    case APPA_CONTROL_TOOL_NAMES.inspectPlan: {
      const parsed = InspectPlanArgsSchema.safeParse(params.args ?? {});
      if (!parsed.success) return validationResult(parsed.error.message);
      const wireContext = normalizeAppaWireContext({
        metadata: params.wireContext,
        wireContext: parsed.data.wire_context,
      });
      if (!wireContext) return { kind: "result", result: unavailableResult() };
      return toDispatch(
        await params.service.inspectPlan({
          principal,
          controlSession,
          wireContext,
          intentId: parsed.data.intent_id,
        }),
      );
    }
    case APPA_CONTROL_TOOL_NAMES.executeRemedy: {
      const parsed = ExecuteRemedyArgsSchema.safeParse(params.args ?? {});
      if (!parsed.success) return validationResult(parsed.error.message);
      const wireContext = normalizeAppaWireContext({
        metadata: params.wireContext,
        wireContext: parsed.data.wire_context,
      });
      if (!wireContext) return { kind: "result", result: unavailableResult() };

      if (params.elicitationResponse !== undefined) {
        if (!params.verifiedRequestState) {
          return { kind: "result", result: unavailableResult() };
        }
        return toDispatch(
          await params.service.recordUntrustedMcpElicitationResponse({
            principal,
            controlSession,
            wireContext,
            intentId: parsed.data.intent_id,
            remedyId: parsed.data.remedy_id,
            verifiedRequestState: params.verifiedRequestState,
            response: params.elicitationResponse,
          }),
        );
      }

      return toDispatch(
        await params.service.executeSelectedNonHumanRemedy({
          principal,
          controlSession,
          wireContext,
          intentId: parsed.data.intent_id,
          remedyId: parsed.data.remedy_id,
        }),
      );
    }
    case APPA_CONTROL_TOOL_NAMES.status: {
      const parsed = StatusArgsSchema.safeParse(params.args ?? {});
      if (!parsed.success) return validationResult(parsed.error.message);
      const wireContext = normalizeAppaWireContext({
        metadata: params.wireContext,
        wireContext: parsed.data.wire_context,
      });
      if (!wireContext) return { kind: "result", result: unavailableResult() };
      return toDispatch(
        await params.service.getStatus({
          principal,
          controlSession,
          wireContext,
          intentId: parsed.data.intent_id,
        }),
      );
    }
    default:
      return { kind: "result", result: unavailableResult() };
  }
}

export function assertNoAppaControlToolCollisions(
  tools: ReadonlyArray<{ name: string }>,
): void {
  const collisions = tools
    .map((tool) => tool.name)
    .filter((name) => isReservedAppaControlToolName(name));
  if (collisions.length > 0) {
    throw {
      code: -32603,
      message: "Reserved APPA control tool name collision.",
    };
  }
}

// === Internal ===

function deriveAppaControlPrincipal(params: {
  profileId: string;
  tokenAuth: TokenAuthContext | undefined;
}): AppaControlPrincipal | null {
  const { profileId, tokenAuth } = params;
  if (!tokenAuth?.organizationId || !tokenAuth.tokenId) return null;

  return {
    organizationId: tokenAuth.organizationId,
    gatewayProfileId: profileId,
    subject:
      tokenAuth.userId &&
      (tokenAuth.isUserToken ||
        tokenAuth.isSessionAuth ||
        tokenAuth.isExternalIdp)
        ? { kind: "user", id: tokenAuth.userId }
        : { kind: "gateway_token", id: tokenAuth.tokenId },
  };
}

function toDispatch(
  response: AppaControlOperationResponse,
): AppaControlDispatch {
  if (response.state === "human_review_required") {
    return {
      kind: "input_required",
      request: {
        method: "elicitation/create",
        params: {
          mode: "form",
          message: response.elicitation.message,
          requestedSchema: response.elicitation.requestedSchema,
        },
      },
    };
  }

  return {
    kind: "result",
    result: {
      content: [{ type: "text", text: JSON.stringify(response.result) }],
      structuredContent: response.result,
      isError: response.state === "rejected",
    },
  };
}

function validationResult(message: string): AppaControlDispatch {
  return {
    kind: "result",
    result: {
      content: [
        { type: "text", text: `Invalid APPA control parameters: ${message}` },
      ],
      isError: true,
    },
  };
}

function unavailableResult(): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: "APPA controls are unavailable for this authenticated gateway profile.",
      },
    ],
    isError: true,
  };
}

function createTool(params: {
  name: string;
  title: string;
  description: string;
  schema: z.ZodType;
}): Tool {
  return {
    name: params.name,
    title: params.title,
    description: params.description,
    inputSchema: z.toJSONSchema(params.schema, {
      io: "input",
    }) as Tool["inputSchema"],
  };
}
