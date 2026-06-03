# Sorting your MCP tools

Sorting Hat MCP adds a first-party authorization step for MCP tool calls. It sorts each tool into a house from the tool name and description, casts the user's Patronus, and only forwards the call when the house-specific authorization rules pass.

## Sorting prompt

The Sorting Hat stream should speak in short partial events so the chat UI can render the monologue token by token:

```text
A thread of intent, a glimmer of might,
I weigh {tool_name} by risk and light,
Where purpose and peril both start to sing,
I name {house} for this tool-call thing.
```

Clients can pass the `please_not_slytherin` request header when the user whispers a house preference. The server still evaluates risk first, then shifts a Slytherin result to Ravenclaw with reduced confidence.

## Authorization

- `sorting_hat.sort(tool_name, tool_description)` returns `{ house, confidence }`.
- `patronus.cast(user_id, "expecto_patronum")` returns a stable `{ form, corporeal }` result for the same user id.
- Slytherin-sorted tools require a corporeal Patronus.
- Gryffindor-sorted tools can use the Golden Snitch loader by subscribing to `quidditch.stream(tool_call_id)`.
- Successful tool calls can use `floo.travel(from_server, to_server, payload)` to carry green flame particle metadata alongside the proxied payload.
