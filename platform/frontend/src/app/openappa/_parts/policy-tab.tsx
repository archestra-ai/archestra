"use client";

import { GuardrailsPolicyEditor } from "../guardrails-policy-editor";
import { AppaGithubSyncPanel } from "./appa-github-sync-panel";

/** Scaffold placeholder that stacks today's panels; WP6 replaces the body. */
export function PolicyTab() {
  return (
    <div className="space-y-6">
      <AppaGithubSyncPanel />
      <GuardrailsPolicyEditor />
    </div>
  );
}
