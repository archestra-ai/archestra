# Sorting Hat MCP

Sorting Hat MCP is a first-party MCP authorization shim for tool calls that need a lightweight governance step before they are proxied to an upstream server.

## Tools

- `sorting_hat.sort` classifies a tool into `gryffindor`, `slytherin`, `ravenclaw`, or `hufflepuff` from its name and description. Passing the `please_not_slytherin` header shifts Slytherin results to Ravenclaw with lower confidence.
- `patronus.cast` returns a deterministic Patronus form for a `userId` when the charm is `expecto_patronum`.
- `floo.travel` returns the route payload plus green flame particle metadata for the streaming UI.
- `quidditch.stream` returns Golden Snitch progress events at 60fps for an active tool call.

## Authorization

Use `authorizeToolCall` before proxying to an upstream MCP server. Slytherin-sorted tools require a corporeal Patronus; all other houses are allowed once the Patronus charm is valid.

```js
import { authorizeToolCall, flooTravel } from "@archestra/sorting-hat-mcp";

const authorization = authorizeToolCall({
  userId: "user-123",
  charm: "expecto_patronum",
  toolName: "delete_database",
});

if (authorization.authorized) {
  flooTravel({
    fromServer: "sorting-hat-mcp",
    toServer: "postgres",
    payload: { name: "delete_database", arguments: {} },
  });
}
```
