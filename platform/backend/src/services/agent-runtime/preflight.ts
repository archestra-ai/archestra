import type { A2AActor } from "@/agents/a2a/a2a-base";
import type { Agent, ResolvedAgentRuntime } from "@/types";
import { AgentRuntimeCredentialsRequiredError, ApiError } from "@/types";
import { claudeCodeAccountManager } from "./claude-code-account";
import { preflightAgentRuntimeCredentials } from "./credentials";
import { preflightAgentRuntimeModelCompatibility } from "./model-compatibility";

/** Reject actionable setup failures before returning a detached task handle. */
export async function preflightAgentRuntimeLaunch(params: {
  runtime: ResolvedAgentRuntime;
  agent: Agent;
  actor: A2AActor;
}) {
  const { runtime, agent, actor } = params;
  const userId = actor.kind === "user" ? actor.id : null;
  const { usesClaudeCodeSubscription } =
    await preflightAgentRuntimeModelCompatibility({
      runtime,
      agent,
      organizationId: actor.organizationId,
      userId: userId ?? "system",
    });
  const credentials = await preflightAgentRuntimeCredentials({
    runtime,
    organizationId: actor.organizationId,
    userId,
  });
  if (credentials.misconfigured.length > 0) {
    throw new ApiError(
      409,
      `This Agent's Agent Runtime is missing shared credentials an administrator must configure: ${credentials.misconfigured.map((entry) => entry.label).join(", ")}`,
    );
  }
  if (credentials.missing.length > 0) {
    throw new AgentRuntimeCredentialsRequiredError(
      runtime.agentId,
      credentials.missing,
    );
  }
  if (usesClaudeCodeSubscription) {
    if (!userId) {
      throw new ApiError(
        409,
        "A personal Claude subscription requires a run acting as a signed-in user.",
      );
    }
    const account = await claudeCodeAccountManager.status({
      runtime,
      userId,
      inspectFlow: false,
    });
    if (account.state !== "connected") {
      throw new AgentRuntimeCredentialsRequiredError(runtime.agentId, [
        {
          key: "CLAUDE_CODE_ACCOUNT",
          label: "Claude Code account",
          description:
            "Sign in with your own Claude account for this runtime image.",
        },
      ]);
    }
  }
}
