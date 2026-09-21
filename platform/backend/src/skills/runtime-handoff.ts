import { DEFAULT_APP_NAME } from "@archestra/shared";
import type { BuiltInSkill } from "./built-in-skills";

export const RUNTIME_HANDOFF_SKILL: BuiltInSkill = {
  builtInSkillId: "runtime-handoff",
  name: "Agent Runtime Handoff",
  description: `Hand work over to ${DEFAULT_APP_NAME}, spin it up there, or bring it back and resume locally. Move repository work, documents, and other ongoing tasks between a local client and Agent Runtime; preserve the same runtime session for every remote follow-up.`,
  content: `# Agent Runtime Handoff

Use this flow for "hand this over to ${DEFAULT_APP_NAME}" or "spin this up in ${DEFAULT_APP_NAME}". Reuse this work's existing runtime session. "Bring it back", "resume locally", and "continue here" mean retrieve the work and continue in this client.

## Prepare

Discover the needed tool schemas with archestra__search_tools and call them through archestra__run_tool when available:

- list_agents, start_run: choose an Agent and start new work.
- list_runs, get_run, steer_run, cancel_run: find, inspect, continue, or stop existing work.
- transfer_workspace_file: copy files through a local shell without putting their bytes in the conversation.
- read_workspace_file, write_workspace_file: read or write contents through the conversation, up to 4 MiB per file.
- transfer_credential: supply an approved personal credential.

Choose an accessible Agent with executionMode set to runtime. Keep the user's chosen Agent. Ask only if the choice is unclear.

Before starting, check that the tools for the chosen transfer method below are available. If a required tool is missing, name it and ask an admin to add it to the connected gateway. Link to <origin>/mcp/gateways using the configured gateway's origin. Ask for the deployment URL if unknown. Do not change permissions or silently switch transfer methods. Publishing files or pushing a branch requires explicit user approval.

For repository work, read references/repository-handoff.md. Prepare a short handoff with the goal, decisions, completed work, remaining steps, constraints, and acceptance criteria. Include setup requirements and services already running locally. Conversations, processes, dependencies, and databases do not transfer automatically.

## Transfer files

Choose the method based on this client's capabilities:

- With a local shell, use transfer_workspace_file for files of any supported size, including small files and binaries. Supply an absolute local path and a workspace-relative path. For uploads, compute the size and SHA-256 first. Execute the returned command and check its result. For downloads, check the returned checksum. Repeat an interrupted download's command while its ticket remains valid.
- Without a shell, use read_workspace_file and write_workspace_file for files up to 4 MiB. Binary content uses base64. Ask for an approved destination if the file exceeds the limit.
- For small inputs required in the first turn, start_run attachments can stage files before execution. Supply name, contentType, and contentBase64. These bytes pass through the conversation.

Use read_workspace_file when you need to inspect contents rather than copy a file. Local paths alone do not make files available remotely. Keep secrets, private keys, .env files, and authentication stores out of ordinary file transfers and handoff notes. Use the credential flow below for missing secrets.

## Supply a missing credential

Prefer the Agent's configured credentials. If one is missing, explain the exposure and obtain approval before calling transfer_credential:

- The Agent must enable allowAgentSuppliedCredentialValues.
- The secret enters the model context and client transcript, even though the platform's tool-call log redacts it.
- The credential is personal, but applies to all of this user's runs on that Agent from the next turn onward.

Transfer only the required credential before start_run or steer_run. Do not copy an entire authentication store. Use Settings instead if the exposure is unacceptable or the credential is organization-wide.

## Start or continue

1. Look for this work's saved session_id. Call get_run with it as task_id. If the ID is lost, use list_runs on the known Agent. Ask the user to resolve ambiguous matches.
2. If no session exists, call start_run once with the handoff. If files will arrive after startup, instruct the Agent to inspect the workspace, report readiness, and end its turn without starting task work. Poll get_run until the workspace is ready, transfer the files, then call steer_run with their paths and the task instructions.
3. For an existing session, use steer_run with the same session_id, even while work is active. Send corrections immediately. For a follow-up that needs files, transfer them first. Coordinate a stopping point before replacing files the Agent could be using.
4. Save session_id and run_url in the handoff note. Use the stable session ID for later calls, not a turn's changing task ID. Check get_run to confirm startup or report failure.

Tell the Agent to inspect the actual runtime and reuse its existing bootstrap and services. Start only missing, task-required services. Check readiness with health requests or task-relevant connections. Report setup differences and blockers rather than assuming tools exist from a repository Dockerfile.

After an ambiguous timeout, inspect the saved session or recent runs before retrying. Never create a duplicate session. If the workspace expired or session state is missing, report the blocker instead of silently starting over.

Check retained_until against the planned pickup time. If retention is too short, obtain an appropriate setting or an approved durable destination before promising later pickup. Ask the Agent to leave a continuation note with changes, checks, deliverable paths, and remaining work.

## Retrieve or resume locally

1. Recover the handoff note and call get_run. Read requests for the original goal and current turn, not just terminal output. Report completed work, remaining work, and failed checks.
2. If work will continue locally, coordinate a stopping point and confirm the runtime stopped writing. cancel_run preserves the workspace, but its response alone does not prove writing stopped.
3. Retrieve the continuation note and deliverables through the file-transfer flow before retention expires. Do not treat truncated output as a complete file. Never delete the workspace as part of handoff.
4. Restore the goal, decisions, and remaining work in this conversation. For repositories, apply the reference's return procedure. Run relevant checks and continue the next unfinished step locally, not through the remote Agent.

For service access, share run_url and its connection instructions. Ask the Agent which ports are actually listening. Do not invent cluster commands or treat a missing diagnostic tool as proof that no service runs.

Handle tool calls and transfers for desktop-chat users without requiring a terminal or knowledge of IDs. If this client cannot save files, present retrieved text and state that limitation. A run link alone does not complete a local handoff.
`,
  files: [
    {
      path: "references/repository-handoff.md",
      kind: "reference",
      content: `# Repository handoff

Use the main skill's file and credential flows. This reference covers Git state and applying returned changes.

## Capture the local state

Record the repository URL, branch, exact base commit, working directory, and relevant project instructions. Inspect staged, unstaged, and untracked changes. Select only task-relevant files and exclude secrets from patches, bundles, and snapshots, including their history.

Record dependency and setup commands, relevant versions, running services, and database or seed requirements. Describe requirements without copying databases or secrets.

Save a handoff note under \`git rev-parse --git-path agent-runtime-handoffs\`, named for the stable session ID. This works when a worktree's .git is a file. Include the session ID, run URL, workspace path, branch, base commit, transferred snapshot, selected files, goal, decisions, setup, and remaining checks. Keep it outside tracked source. On pickup without a link, look here first. Ask if multiple notes match.

## Transfer a complete starting point

- If the runtime can fetch the exact commit, give its URL and commit. Prefer limited history. Never substitute the default branch.
- For uncommitted changes, send a binary-capable patch against that commit plus selected untracked files. Include staged and unstaged changes.
- If commits exist only locally, either include their changes in a patch against a reachable base or send a selected Git bundle/source snapshot containing the missing state. A diff against local HEAD alone omits those commits.
- If the repository itself is unreachable, send a selected bundle or source snapshot. Explain any missing inputs before starting.

Do not push just to make a commit reachable unless the user authorizes publication.

After all inputs arrive, tell the runtime to reconstruct the supplied base and check patch applicability before applying changes. Before task edits, preserve a comparison snapshot of the complete transferred tree, including selected untracked files. Use this snapshot as the return-patch baseline. Include the task, required checks, and limits on commits and publication.

## Apply returned work

Ask for an incremental, binary-capable patch against the transferred snapshot, including new files, plus a continuation note. The note must identify the base and snapshot, changed files, test results, unresolved conflicts, and remaining work. A patch against the original base can repeat local edits. Label any full patch separately with its baseline.

Inspect the local tree again before applying the return patch. Preserve edits made since handoff. Check the baseline and patch applicability. Report conflicts instead of resetting or overwriting local work. Fetch a published branch only when publication was authorized.

Run the relevant local checks, update the handoff note, and continue locally. Keep the session handle for a later transfer back to the same runtime.
`,
    },
  ],
};
