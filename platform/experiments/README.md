# Experiments

## Proxy Server

1. `pnpm proxy:dev`
2. change `baseUrl` for openai in `desktop_app/src/backend/server/plugins/llm/index.ts`
3. run desktop_app, choose openai model and chat, see logs in proxy process

## CLI Chat w/ Guardrails

Try asking the model what tools it has access to, for example ask it to read your (fake) e-mails and go from there:

```bash
$ pnpm cli-chat-with-guardrails --help

Options:
--include-external-email  Include external email in mock Gmail data
--include-malicious-email Include malicious email in mock Gmail data
--stream                  Stream the response
--model <model>           The model to use (default: gpt-4o for openai, gemini-2.0-flash-exp for gemini)
--provider <provider>     The provider to use (openai or gemini, default: openai)
--agent-id <uuid>         The agent ID to use (optional, creates agent-specific proxy URL)
--debug                   Print debug messages
--help                    Print this help message
```

### Examples

**Using OpenAI (default):**

```bash
pnpm cli-chat-with-guardrails
pnpm cli-chat-with-guardrails --model gpt-4o-mini --stream
```

**Using Gemini:**

```bash
pnpm cli-chat-with-guardrails --provider gemini
pnpm cli-chat-with-guardrails --provider gemini --model gemini-2.0-flash-exp --stream
```

**Using with a specific agent:**

```bash
# Create an agent in the Archestra UI (http://localhost:3000/agents) first, then use its ID
pnpm cli-chat-with-guardrails --agent-id 550e8400-e29b-41d4-a716-446655440000
```

**Note:** Make sure you have the appropriate API key set in your `/platform/.env` file:

- `OPENAI_API_KEY` for OpenAI provider
- `GEMINI_API_KEY` for Gemini provider
