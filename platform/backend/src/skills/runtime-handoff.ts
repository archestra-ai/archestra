import type { BuiltInSkill } from "./built-in-skills";

export const RUNTIME_HANDOFF_SKILL: BuiltInSkill = {
  builtInSkillId: "runtime-handoff",
  name: "Agent Runtime Handoff",
  description:
    "Move ongoing work between a local client and Agent Runtime, let it continue while you are away, and pick it up later. Use for repository work, research, documents, and other long-running tasks; preserve the same runtime session for every follow-up.",
  content: `# Agent Runtime Handoff

Use Archestra's connected tools to move work between clients and a retained runtime session. The local client's conversation does not automatically transfer: send a concise handoff with the goal, decisions, completed work, remaining steps, constraints, and acceptance criteria.

## Discover once

Find the actual tool names and schemas through archestra__search_tools when available, then call them through archestra__run_tool. The lifecycle tools are start_run, get_run, list_runs, steer_run, and cancel_run. Do not guess older names such as start_task or steer_task. If a required tool is unavailable, explain which capability the connected gateway needs; do not substitute an unrelated tool or change permissions.

Use list_agents to identify an accessible Agent with Agent Runtime configured. Reuse the user's chosen Agent. Ask only when the choice or scope cannot be determined.

## Hand off

1. If this work already has a runtime session, call get_run with its saved session ID (as task_id). Recover a lost ID with list_runs on the known Agent. Do not choose among ambiguous matches without the user.
2. For NEW runtime work, call start_run once. Put the handoff in message and include needed documents or patches in attachments: name, contentType, contentBase64. Files are staged before execution. A path on the laptop is not a file the runtime can read.
3. For EXISTING runtime work, use steer_run. It continues the same workspace and saved conversation, including after a previous turn finishes. Send additional files with write_workspace_file using workspace-relative paths before referring to them in the follow-up.
4. Save the returned session_id and run_url in the conversation's handoff note. The task ID can change between turns; the session ID stays stable. Poll get_run until startup is confirmed or it reports a failure. An accepted request alone does not prove the work started.

A retry must never create another session. After an ambiguous timeout, inspect the known session or list recent runs before repeating a start. If a workspace expired or saved session state is missing, report that blocker and preserve existing work. Do not silently call start_run.

## Pick up in any client

Read get_run with the saved session ID. Report what completed, what remains, and any failed checks. Read deliverables with read_workspace_file using workspace-relative paths (for example, reports/summary.md); use base64 for binary files. Output can be truncated: retrieve the actual deliverable instead of treating a partial response as complete.

If work will continue locally, coordinate a stopping point with the runtime and verify it stopped writing before applying its files. cancel_run stops active work while preserving the workspace. Download results before retention expires. Never delete a workspace as part of handoff.

For people using a desktop chat client, handle tool calls and file transfer yourself. Give a short progress summary, the run link, and the finished document or result. Do not require a terminal, repository, or knowledge of IDs. A client without file-saving tools can present the retrieved text; do not claim a file was saved locally.

For repository work, read references/repository-handoff.md. Ask the runtime to finish with a handoff note describing changes, verification, deliverable paths, and remaining decisions. Continue later with steer_run and the same session ID.
`,
  files: [
    {
      path: "references/repository-handoff.md",
      kind: "reference",
      content: `# Repository handoff

Capture the repository URL, branch, exact base commit, working directory, and relevant project instructions. Inspect staged, unstaged, and untracked changes. Never transfer credentials, private keys, .env files, or authentication stores.

For committed work reachable by the runtime, identify the exact commit. For local-only work, include a binary-capable patch plus explicitly selected untracked files as start_run attachments. A patch alone does not include untracked files or local-only commits. For a repository the runtime cannot fetch, transfer an explicitly selected Git bundle or source snapshot as well. Explain missing inputs before starting. Do not push merely to make handoff easier unless the user authorized it.

Tell the runtime to check out the exact base, check patch applicability, and apply only supplied changes. Before making new edits, preserve a comparison snapshot of the transferred working tree, including selected untracked files. This is the return-patch baseline; it already contains the local edits. Include the remaining task, checks to run, and limits on commits, pushes, and publication. Never send credentials in the handoff message; use the Agent's configured connections.

Before returning work locally, ask for the base commit, handed-off snapshot, changed files, test results, unresolved conflicts, and a short continuation note. When local uncommitted work was transferred, request an incremental, binary-capable patch against the handed-off snapshot, including newly created files. A patch against the original commit would repeat local edits and may not apply. Keep any full patch separately and label its baseline. Fetch a published branch only when publication was authorized; otherwise retrieve a patch and selected new files using read_workspace_file. Large deliverables need an accessible repository or artifact location approved by the user.

Inspect the local working tree again before applying results. Preserve edits made since handoff. Verify the base and check patch applicability before applying; surface conflicts instead of resetting, overwriting, or force-pushing. Run the relevant checks locally, then summarize what is ready and what still needs work.
`,
    },
  ],
};
