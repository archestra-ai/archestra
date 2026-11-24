"use client";

import { ClientRedirect } from "@/components/client-redirect";
import { useServerRulesAccess } from "@/lib/openappa-github-sync.query";
import { POLICY_WORKSPACE_PATH } from "@/lib/openappa-policy-views";
import { PolicySourceEditor } from "../_parts/policy-source-editor";

/**
 * The organization's policy: its source, file by file, and the effective
 * rules. A reader of MCP servers' rules alone has no organization policy to
 * read, so they are sent to the file workspace, which lists their files.
 */
export function PolicyPage({
  sourceEntry,
  focusLine,
}: {
  sourceEntry?: string;
  focusLine?: number;
}) {
  const { scoped } = useServerRulesAccess();
  if (scoped === null) return null;
  if (scoped) return <ClientRedirect to={POLICY_WORKSPACE_PATH} keepQuery />;
  return <PolicySourceEditor sourceEntry={sourceEntry} focusLine={focusLine} />;
}
