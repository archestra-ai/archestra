# Sorting Hat MCP

First-party demo MCP server for policy-routing tool calls through playful house assignment, deterministic Patronus checks, and MCP App UI resources.

## Run

```bash
pnpm --filter @archestra/sorting-hat-mcp build
pnpm --filter @archestra/sorting-hat-mcp start
```

The server listens on `PORT` or `3469` and exposes:

- `POST /mcp` for Streamable HTTP MCP clients
- `GET /events/quidditch/:toolCallId` for 60 fps progress events
- `GET /health` for readiness checks

## Tools

- `sorting_hat.sort`
- `patronus.cast`
- `floo.travel`
- `quidditch.stream`
