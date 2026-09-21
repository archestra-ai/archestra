import { DEFAULT_APP_NAME } from "@archestra/shared";
import type { BuiltInSkill } from "./built-in-skills";

export const RUNTIME_HANDOFF_SKILL: BuiltInSkill = {
  builtInSkillId: "runtime-handoff",
  name: "Agent Runtime Handoff",
  description: `Hand work over to ${DEFAULT_APP_NAME}, spin it up there, or bring it back and resume locally. Move repository work, documents, and other ongoing tasks between a local client and Agent Runtime; preserve the same runtime session for every remote follow-up.`,
  content: `# Agent Runtime Handoff

Use the connected tools to move work between clients and a retained runtime session. The local client's conversation does not automatically transfer: send a concise handoff with the goal, decisions, completed work, remaining steps, constraints, and acceptance criteria.

Treat "hand this work over to ${DEFAULT_APP_NAME}" and "spin this up in ${DEFAULT_APP_NAME}" as runtime handoff requests. First check whether this work already has a runtime session; these phrases do not authorize duplicate sessions. "Bring it back", "resume locally", and "continue here" mean transfer the work back to this client and continue locally.

## Discover once

Use archestra__search_tools to discover tool names and schemas, then archestra__run_tool to call them, when available. Check the tools needed for this handoff:

- Choose an Agent and start work: list_agents, start_run.
- Find, inspect, continue, or stop a session: list_runs, get_run, steer_run, cancel_run.
- Copy files through a local shell: transfer_workspace_file.
- Read or write file contents through the conversation: read_workspace_file, write_workspace_file. Each has a 4 MiB limit.
- Supply a missing personal credential, with approval: transfer_credential.

If a needed tool is missing, name it and ask an admin to add it to the connected gateway. Do not change permissions yourself. Link to <origin>/mcp/gateways, using the origin from this client's configured MCP gateway URL. If that URL is unavailable, ask for the deployment URL. Never guess the host.

When the handoff has to carry a file — a patch, a bundle, a snapshot, a document — confirm transfer_workspace_file is available before start_run. If it is missing, stop and ask for it to be added, then start the handoff. Do not work around its absence: pushing a branch, publishing the work elsewhere, or spending the file's bytes as base64 through the conversation are the user's decisions to make, not substitutes you choose, and publishing anything needs the user's explicit authorization. Offer those alternatives only after naming the missing tool.

Use list_agents to identify an accessible Agent with executionMode set to runtime. Foreground agents do not retain a runtime workspace or support steering. Reuse the user's chosen Agent. Ask only when the choice or scope cannot be determined.

## Hand off

1. If this work already has a runtime session, call get_run with its saved session ID (as task_id). Recover a lost ID with list_runs on the known Agent. Do not choose among ambiguous matches without the user.
2. For NEW runtime work, call start_run once. Put the handoff in message. A path on the laptop is not a file the runtime can read, so send files one of two ways: attachments (name, contentType, contentBase64), which are staged before the first turn but pass through the conversation as base64; or transfer_workspace_file after the run starts, which moves the bytes directly. Reserve attachments for small inputs the first turn cannot begin without, and transfer everything else.
3. For EXISTING runtime work, use steer_run immediately, including while the run is working. Do not wait for completion to send a correction. It continues the same workspace and saved conversation, including after a previous turn finishes. Transfer any needed files before the follow-up, using the file tools below.
4. Save the returned session_id and run_url in the conversation's handoff note. The task ID can change between turns; the session ID stays stable. Poll get_run until startup is confirmed or it reports a failure. An accepted request alone does not prove the work started.

A runtime workspace may already run the project's development environment, started by the image's own bootstrap before your first turn. Record in the handoff message which services the local session had running and how they were started, then ask the runtime to report what is already serving before it starts anything. Starting a second stack on top of a running one wastes the workspace, and no particular tool is guaranteed to exist in an image.

Tell the receiving agent to inspect the actual runtime and bootstrap state, not infer its capabilities from a repository Dockerfile alone. Reuse existing setup; recreate only missing, task-required setup using repository guidance and allowed runtime capabilities. Verify service readiness with real checks, such as a health request or task-relevant connection, and report setup differences and blockers. Use existing approved access. If a credential is missing, follow the credential instructions below.

Check retained_until against the user's intended pickup time. For overnight work, do not promise next-morning pickup if the workspace expires first. Explain the deadline and obtain an appropriate retention setting or an authorized durable delivery destination before the user leaves.

A retry must never create another session. After an ambiguous timeout, inspect the known session or list recent runs before repeating a start. If a workspace expired or saved session state is missing, report that blocker and preserve existing work. Do not silently call start_run.

## Pick up in any client

Read get_run with the saved session ID. Read requests for the original goal and current turn before interpreting a short follow-up; terminal output alone may show only setup commands. Report what completed, what remains, and any failed checks. Retrieve deliverables with the file tools below. Never treat truncated output as a complete deliverable.

To reach a service running inside the workspace, give the user its run_url: the run's connection details there carry the ready-made commands for attaching a terminal and forwarding ports. Never hand-write cluster commands from memory. Ask the runtime which ports it actually has listening rather than assuming a probe succeeded, because tools such as ss and netstat may be absent and their failure reads as an empty result. Workspace services commonly bind loopback only, which forwards normally.

If work will continue locally, coordinate a stopping point with the runtime and verify it stopped writing before applying its files. cancel_run preserves the workspace, but its response alone does not prove the process stopped writing. Download results before retention expires. Never delete a workspace as part of handoff.

## Transfer files and credentials

Use transfer_workspace_file to copy files, including small files and binaries. Supply a workspace-relative path and an absolute local path. For uploads, first compute the local file's size and SHA-256. Run the returned shell command to move the bytes without putting them in the conversation. Repeat that command to resume an interrupted download while its ticket is valid. Check the downloaded file against the returned checksum.

Use read_workspace_file when the conversation needs a file's contents. Without a shell, use read_workspace_file and write_workspace_file for files up to 4 MiB. Use base64 for binary content. For larger files, ask for an approved destination instead.

Prefer the Agent's configured credentials. If a task needs a missing credential, use transfer_credential only with the user's approval. The Agent must enable allowAgentSuppliedCredentialValues. Explain that the secret enters the model context and client transcript, despite redaction in the platform's tool-call log. Use Settings if that exposure is unacceptable or the credential is organization-wide. A transferred credential applies to all of this user's runs on that Agent, starting with the next turn. Transfer it before start_run or steer_run. Never put secrets in handoff notes or file attachments.

## Resume locally

Recover the saved handoff note, inspect the existing runtime session, and retrieve its continuation note and deliverables. For repository work, follow the reference below to apply the incremental changes safely. Restore the original goal, decisions, remaining steps, and verification results into this local conversation. Run the relevant checks and continue the next unfinished step locally. Returning a run link or downloading a patch alone is not a completed local handoff. Do not steer the runtime to do the next step when the user asked to continue here.

For people using a desktop chat client, handle tool calls and file transfer yourself. Give a short progress summary, the run link, and the finished document or result. Do not require a terminal, repository, or knowledge of IDs. A client without file-saving tools can present the retrieved text; do not claim a file was saved locally.

For repository work, read references/repository-handoff.md. Ask the runtime to finish with a handoff note describing changes, verification, deliverable paths, and remaining decisions. Continue later with steer_run and the same session ID.
`,
  files: [
    {
      path: "references/repository-handoff.md",
      kind: "reference",
      content: `# Repository handoff

Capture the repository URL, branch, exact base commit, working directory, and relevant project instructions. Inspect staged, unstaged, and untracked changes. Never transfer credentials, private keys, .env files, or authentication stores.

Include a concise environment summary: setup and dependency commands, relevant versions when known, services currently running and how they were started, and local database or seed requirements. Processes, installed dependencies, and database contents do not automatically transfer. Describe requirements without dumping databases or including secrets; a context summary is sufficient.

Persist a local handoff note so a fresh local conversation can recover it. Resolve its directory with \`git rev-parse --git-path agent-runtime-handoffs\` (a worktree's .git may be a file). Store a note named for the stable session ID there, containing the run link, workspace path, branch, base commit, transferred snapshot, selected untracked files, goal, decisions, environment summary, remaining steps, and required checks. Keep it outside the tracked source tree and omit secrets. On a local pickup request without a link, look here; ask only if multiple notes plausibly match the requested work.

For committed work reachable by the runtime, include the repository URL and exact commit. Prefer fetching that commit with limited history instead of cloning the entire history. Never substitute the default branch when the requested commit is unavailable. For local-only work, send a binary-capable patch plus explicitly selected untracked files with transfer_workspace_file, falling back to start_run attachments only for inputs the first turn cannot begin without. A patch alone does not include untracked files or local-only commits, and local-only commits are local-only work: a runtime that can reach the repository still cannot fetch a commit that was never published. For a repository the runtime cannot fetch, transfer an explicitly selected Git bundle or source snapshot as well. Explain missing inputs before starting. Do not push merely to make handoff easier unless the user authorized it; transferring the work is the default, and a push is a publication decision the user makes.

Tell the runtime to check out the exact base, check patch applicability, and apply only supplied changes. Before making new edits, preserve a comparison snapshot of the transferred working tree, including selected untracked files. This is the return-patch baseline; it already contains the local edits. Include the remaining task, checks to run, and limits on commits, pushes, and publication. Never send credentials in the handoff message; use the Agent's configured connections. When the task needs a credential the Agent does not have, transfer_credential stores one personally for you on an Agent that accepts client-supplied values; it reaches the workspace on the next turn, so transfer before steering.

Before returning work locally, ask for the base commit, handed-off snapshot, changed files, test results, unresolved conflicts, and a short continuation note. When local uncommitted work was transferred, request an incremental, binary-capable patch against the handed-off snapshot, including newly created files. A patch against the original commit would repeat local edits and may not apply. Keep any full patch separately and label its baseline. Fetch a published branch only when publication was authorized. Otherwise, retrieve the patch and selected new files with transfer_workspace_file. Without a shell, use read_workspace_file within its 4 MiB limit or ask for an approved artifact destination.

Inspect the local working tree again before applying results. Preserve edits made since handoff. Verify the base and check patch applicability before applying; surface conflicts instead of resetting, overwriting, or force-pushing. Run the relevant checks locally, then summarize what is ready and what still needs work.

Update the local handoff note with retrieved files, checks, and remaining steps. Continue coding locally when the user asked to resume. Keep the remote session handle for any later handoff back to the same retained runtime; never create a replacement silently if that session expired.
`,
    },
  ],
};
