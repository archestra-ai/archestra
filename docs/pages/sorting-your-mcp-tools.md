# Sorting your MCP tools

Sorting Hat MCP is a first-party MCP server that demonstrates tool-call routing, deterministic user authorization, and MCP App rendering in Archestra.

## Tools

- `sorting_hat.sort(tool_name, tool_description)` assigns a tool to a risk house and returns a confidence score.
- `patronus.cast(user_id, charm)` returns a stable Patronus form for the same user id.
- `floo.travel(from_server, to_server, payload)` checks the sorted house and Patronus before routing a payload.
- `quidditch.stream(tool_call_id)` returns an event stream URL and an MCP App progress view.

## Evidence

- [Demo video: Slytherin blocked by non-corporeal Patronus](/docs/automated_screenshots/sorting-hat-mcp_demo.webm)

![Gryffindor sorting result](/docs/automated_screenshots/sorting-hat-mcp_gryffindor.webp)
![Slytherin sorting result](/docs/automated_screenshots/sorting-hat-mcp_slytherin.webp)
![Ravenclaw sorting result](/docs/automated_screenshots/sorting-hat-mcp_ravenclaw.webp)
![Hufflepuff sorting result](/docs/automated_screenshots/sorting-hat-mcp_hufflepuff.webp)

## Prompt

Use this system instruction when wiring the server into an agent:

```text
Before each MCP tool takes flight, ask the Hat to judge it right.
Call sorting_hat.sort with name and tale, then read the house before you sail.
If slytherin shadows mark the track, cast patronus.cast before going back.
Then floo.travel may carry the load; say if it passed or blocked the road.
```

## Run locally

```bash
cd platform
pnpm --filter @archestra/sorting-hat-mcp build
pnpm --filter @archestra/sorting-hat-mcp start
```

Use `http://localhost:3469/mcp` as the Streamable HTTP MCP endpoint.
