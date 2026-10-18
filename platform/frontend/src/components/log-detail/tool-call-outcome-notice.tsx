import { CircleStop, ShieldX, TriangleAlert } from "lucide-react";
import {
  InlineNotice,
  InlineNoticeBody,
  InlineNoticeText,
} from "@/components/ui/inline-notice";
import type { McpToolCallOutcomeStatus } from "@/lib/mcp-logs/tool-call-content";

/**
 * Why a logged MCP call did not succeed, said in words above its payload: a
 * refusal names what kept the tool from running, an error carries its
 * message, and a cancellation says it was stopped. Nothing for a success or
 * an outcome the row does not record.
 */
export function ToolCallOutcomeNotice({
  status,
  message,
}: {
  status: McpToolCallOutcomeStatus;
  message: string | null;
}) {
  if (status === "blocked") {
    return (
      <InlineNotice variant="warning">
        <ShieldX />
        <InlineNoticeBody>
          <span className="font-medium">Blocked, not run</span>
          <InlineNoticeText className="break-words whitespace-pre-wrap">
            {message ??
              "The platform refused this call before it reached the server."}
          </InlineNoticeText>
        </InlineNoticeBody>
      </InlineNotice>
    );
  }
  if (status === "error") {
    return (
      <InlineNotice variant="error">
        <TriangleAlert />
        <InlineNoticeBody>
          <span className="font-medium">The call failed</span>
          <InlineNoticeText className="line-clamp-6 break-words whitespace-pre-wrap">
            {message ?? "The result was marked as an error."}
          </InlineNoticeText>
        </InlineNoticeBody>
      </InlineNotice>
    );
  }
  if (status === "cancelled") {
    return (
      <InlineNotice variant="neutral">
        <CircleStop />
        <InlineNoticeBody>
          <span className="font-medium">Cancelled</span>
          <InlineNoticeText className="break-words whitespace-pre-wrap">
            {message ?? "The call was stopped before it finished."}
          </InlineNoticeText>
        </InlineNoticeBody>
      </InlineNotice>
    );
  }
  return null;
}
