# OpenAPPA status in Chat

1. Add a checked status read to the OpenAPPA Rust runtime in a separate worktree and open an upstream PR. Keep its existing status API compatible.
2. Pin the upstream PR commit in Archestra. Add a NAPI read that resolves the recorded session root and returns its trust and audience.
3. Add a Chat status endpoint. Check conversation access first. For every locked chat, return `null` immediately, with or without a browser key, and never read OpenAPPA status. For other chats, return `null` when Guardrails V2 is off or no session exists.
4. Show read-only trust and audience info beside the model and effort controls when status exists. Refresh after a Chat turn finishes. Do not add stream events.
5. Test the Rust read, endpoint access and locked-chat behavior, frontend display, and a local OpenAPPA-enabled Chat flow. Open a draft Archestra PR that pins the upstream PR commit.
