# Analysis: swap_agent Tool Failure in Slack/Teams

## Issue
The `swap_agent` tool allows an agent to hand over the conversation to another agent. While this works in the web UI, it fails in Slack and MS Teams integrations. Subsequent messages in the same thread continue to be handled by the original (default) agent instead of the newly swapped agent.

## Root Cause
The root cause lies in `ChatOpsManager.processMessage` in `platform/backend/src/agents/chatops/chatops-manager.ts`. 

In the web UI, a conversation is identified by a unique UUID, and the frontend always sends this UUID. The backend loads the conversation from the database, which contains the current `agentId`. When `swap_agent` is called, it updates the `agentId` in the `conversations` table.

In Slack/Teams:
1. `ChatOpsManager.processMessage` is triggered by a webhook.
2. It identifies the "default" agent by looking up the `ChatOpsChannelBindingModel` for the channel/workspace.
3. It **ignores** any existing `ConversationModel` (mapped to the thread via `sessionId`) that might have a different `agentId` due to a previous `swap_agent` call.
4. It only allows overriding the default agent via an inline mention (e.g., `AgentName > message`).
5. Consequently, even if `swap_agent` successfully updates the conversation in the database, the next message processed by `ChatOpsManager` reverts to the channel's default agent because it never checks the conversation state.

## Proposed Fix
Modify `ChatOpsManager.processMessage` to:
1. Calculate the `sessionId` (which acts as the `conversationId`) for the incoming message thread.
2. Check if a conversation already exists for this `sessionId` in the database.
3. If it exists, retrieve the `agentId` from the conversation.
4. Use this `agentId` as the default agent for the current message, instead of always falling back to the channel binding's agent.

## Verification Plan
1. **Code Audit**: Ensure `buildChatOpsSessionId` is used consistently to map threads to conversations.
2. **Unit Test**: (If possible) Mock a conversation with a swapped agent and verify `processMessage` selects the correct agent.
3. **Manual Verification**: Test the flow in Slack/Teams (requires deployment).
