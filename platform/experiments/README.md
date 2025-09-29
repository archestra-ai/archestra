# Experiments

## Getting started

1. `pnpm install`
2. `cp .env.example .env` + add necessary environment variables (right now just `OPENAI_KEY`)

## Proxy Server

1. `pnpm proxy:dev`
2. change `baseUrl` for openai in `desktop_app/src/backend/server/plugins/llm/index.ts`
3. run desktop_app, choose openai model and chat, see logs in proxy process

## CLI Chat w/ Guardrails

Try asking the model what tools it has access to, for example ask it to read your (fake) e-mails and go from there:

```bash
$ pnpm cli-chat-with-guardrails --help
```
