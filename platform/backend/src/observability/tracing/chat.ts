import {
  context,
  type Span,
  SpanKind,
  SpanStatusCode,
  trace,
} from "@opentelemetry/api";
import {
  CHAT_ROUTE_CATEGORY_KEY,
  SESSION_ID_KEY,
} from "@/observability/request-context";
import type { AgentType } from "@/types";
import {
  ATTR_ARCHESTRA_AGENT_LABEL_PREFIX,
  ATTR_ARCHESTRA_AGENT_TYPE,
  ATTR_ARCHESTRA_SUBAGENT_FAILOVER_COUNT,
  ATTR_ARCHESTRA_SUBAGENT_INITIAL_AGENT_ID,
  ATTR_ARCHESTRA_SUBAGENT_INITIAL_AGENT_NAME,
  ATTR_ARCHESTRA_TRIGGER_SOURCE,
  ATTR_GENAI_AGENT_ID,
  ATTR_GENAI_AGENT_NAME,
  ATTR_GENAI_OPERATION_NAME,
  ATTR_ROUTE_CATEGORY,
  RouteCategory,
  type SpanTeamInfo,
  type SpanUserInfo,
  setSessionId,
  setSpanError,
  setTeamAttributes,
  setUserAttributes,
} from "./attributes";
import { sessionContext } from "./session";

const activeChatSpanState = new WeakMap<
  Span,
  { initialAgentId: string; initialAgentName: string; failoverCount: number }
>();

/**
 * Updates the active parent chat span when in-place subagent failover switches
 * execution to a fallback subagent, preserving the initial primary subagent's
 * identity and failover count as span attributes.
 */
export function updateActiveChatSpanAgent(params: {
  agentId: string;
  agentName: string;
  agentType?: AgentType;
  teams?: SpanTeamInfo[];
  span?: Span;
}): void {
  const span = params.span ?? trace.getSpan(context.active());
  if (!span) return;

  const state = activeChatSpanState.get(span);
  if (state) {
    if (state.failoverCount === 0) {
      span.setAttribute(
        ATTR_ARCHESTRA_SUBAGENT_INITIAL_AGENT_ID,
        state.initialAgentId,
      );
      span.setAttribute(
        ATTR_ARCHESTRA_SUBAGENT_INITIAL_AGENT_NAME,
        state.initialAgentName,
      );
    }
    state.failoverCount += 1;
    span.setAttribute(
      ATTR_ARCHESTRA_SUBAGENT_FAILOVER_COUNT,
      state.failoverCount,
    );
  }

  span.updateName(`chat ${params.agentName}`);
  span.setAttribute(ATTR_GENAI_AGENT_ID, params.agentId);
  span.setAttribute(ATTR_GENAI_AGENT_NAME, params.agentName);
  if (params.agentType) {
    span.setAttribute(ATTR_ARCHESTRA_AGENT_TYPE, params.agentType);
  }
  if (params.teams) {
    setTeamAttributes(span, params.teams, "agent");
  }
}

/**
 * Starts an active parent chat span that groups LLM and MCP tool calls within
 * a single chat turn into a unified trace.
 *
 * Span name format: `chat {agentName}`.
 *
 * @param params.agentName - The agent/profile name
 * @param params.agentId - The agent/profile ID
 * @param params.agentType - The agent type (optional)
 * @param params.sessionId - Conversation/session ID (optional)
 * @param params.labels - Agent labels (optional)
 * @param params.teams - The agent's teams with labels (optional)
 * @param params.userTeams - The requesting user's teams with labels (optional)
 * @param params.routeCategory - The route category (defaults to RouteCategory.CHAT)
 * @param params.triggerSource - The invocation trigger (e.g. "ms-teams", "slack", "email", "mcp-tool")
 * @param params.callback - The callback function to execute within the span context
 * @returns The result of the callback function
 */
export async function startActiveChatSpan<T>(params: {
  agentName: string;
  agentId: string;
  agentType?: AgentType;
  sessionId?: string;
  labels?: { key: string; value: string }[];
  teams?: SpanTeamInfo[];
  userTeams?: SpanTeamInfo[];
  routeCategory?: RouteCategory;
  triggerSource?: string;
  user?: SpanUserInfo | null;
  callback: (span: Span) => Promise<T>;
}): Promise<T> {
  const tracer = trace.getTracer("archestra");
  const routeCategory = params.routeCategory ?? RouteCategory.CHAT;
  const spanName = `chat ${params.agentName}`;

  // Inject session ID into context so it's available to the pino mixin for log correlation
  let ctx = sessionContext(context.active(), params.sessionId).setValue(
    CHAT_ROUTE_CATEGORY_KEY,
    routeCategory,
  );
  if (params.sessionId) {
    ctx = ctx.setValue(SESSION_ID_KEY, params.sessionId);
  }

  return context.with(ctx, () =>
    tracer.startActiveSpan(
      spanName,
      {
        kind: SpanKind.SERVER,
        attributes: {
          [ATTR_ROUTE_CATEGORY]: routeCategory,
          [ATTR_GENAI_OPERATION_NAME]: "chat",
          [ATTR_GENAI_AGENT_ID]: params.agentId,
          [ATTR_GENAI_AGENT_NAME]: params.agentName,
        },
      },
      ctx,
      async (span) => {
        activeChatSpanState.set(span, {
          initialAgentId: params.agentId,
          initialAgentName: params.agentName,
          failoverCount: 0,
        });
        setSessionId(span, params.sessionId);

        if (params.agentType) {
          span.setAttribute(ATTR_ARCHESTRA_AGENT_TYPE, params.agentType);
        }
        if (params.triggerSource) {
          span.setAttribute(
            ATTR_ARCHESTRA_TRIGGER_SOURCE,
            params.triggerSource,
          );
        }

        setUserAttributes(span, params.user);

        if (params.labels && params.labels.length > 0) {
          for (const label of params.labels) {
            span.setAttribute(
              `${ATTR_ARCHESTRA_AGENT_LABEL_PREFIX}${label.key}`,
              label.value,
            );
          }
        }

        setTeamAttributes(span, params.teams, "agent");
        setTeamAttributes(span, params.userTeams, "user");

        try {
          const result = await params.callback(span);
          span.setStatus({ code: SpanStatusCode.OK });
          return result;
        } catch (error) {
          setSpanError({ span, error });
          throw error;
        } finally {
          span.end();
        }
      },
    ),
  );
}
