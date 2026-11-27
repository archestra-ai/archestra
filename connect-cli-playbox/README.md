# Archestra Unified Connect — CLI UX Playbox

Dry-run prototype unifying `/connection` (agent setup) and `/account/devices` (local MCP bridge) into a single `curl | sh` CLI experience.

**Installs nothing, writes zero files, makes zero network calls.** Runs real read-only autodetection for installed agents on your machine.

## Quick try (no checkout needed)

```sh
curl -LsSf https://raw.githubusercontent.com/archestra-ai/archestra/demo/unified-connect-cli/connect-cli-playbox/install.sh | sh
```

## Try all commands locally

```sh
./connect-cli-playbox/archestra --help
./connect-cli-playbox/archestra connect
./connect-cli-playbox/archestra status
./connect-cli-playbox/archestra status --degraded
./connect-cli-playbox/archestra status --offline
./connect-cli-playbox/archestra status --json
./connect-cli-playbox/archestra doctor
./connect-cli-playbox/archestra claude
```

### Flags
- `--demo` — simulate a Mac with 4 detected agents instead of scanning your machine
- `--empty` — simulate a machine with no agents detected yet
- `--no-bridge` — default local MCP bridge to off
- `-y, --yes` — non-interactive defaults
