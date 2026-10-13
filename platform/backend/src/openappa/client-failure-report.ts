import { promisify } from "node:util";
import { gzip } from "node:zlib";
import config from "@/config";
import { enterpriseTier } from "@/enterprise-tier";
import logger from "@/logging";
import OpenAppaYellModel from "@/models/openappa-yell";
import type { OpenAppaSession } from "./service";

/** A client without a remedy transport cannot recover or invoke the yell tool. */
export async function recordOpenAppaClientFailure(params: {
  session: OpenAppaSession;
  toolCallId: string;
  ruling: string;
}) {
  if (!enterpriseTier.isOpenappaActive() || !config.openappa.yellEnabled)
    return;
  try {
    const message =
      "The client could not receive an OpenAPPA remedy because its request did not declare the gateway remedy tools.";
    const row = await OpenAppaYellModel.record({
      organizationId: params.session.organization_id,
      callerId: params.session.caller_id ?? "unknown",
      sessionId: params.session.session_id,
      toolCallId: `client-failure:${params.toolCallId}`,
      message,
      withTrajectory: false,
    });
    // Host integration diagnostics stay local: these are not an agent-vouched
    // upstream report. Include no prompts, arguments, outputs, or credentials.
    const archive = await promisify(gzip)(
      JSON.stringify({
        source: "archestra",
        kind: "missing_remedy_tools",
        message,
        ruling: params.ruling,
        remedy:
          "Connect the MCP gateway and declare get_remedy_plans and execute_remedy_plan in the client's model request.",
      }),
    );
    await OpenAppaYellModel.storeArchive({
      id: row.id,
      organizationId: row.organizationId,
      archive,
    });
  } catch (err) {
    // Reporting failure must never turn the original refusal into an allow.
    logger.warn({ err }, "Could not save OpenAPPA client failure report");
  }
}
