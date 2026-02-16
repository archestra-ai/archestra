---
title: Groq Provider Bootstrap (Draft)
category: Development
order: 3
description: Minimal draft checklist for implementing Groq provider support in Archestra
lastUpdated: 2026-02-16
---

## Purpose

This draft is a minimal implementation checklist to de-risk issue #1856 before full provider wiring.

## Scope of This Draft

- Document required environment variables for proxy and chat
- Define a concrete smoke-test request
- Point to OpenAI-compatible provider references to reduce implementation risk

## Required Environment Variables

```bash
# LLM Proxy
ARCHESTRA_GROQ_BASE_URL=https://api.groq.com/openai/v1

# Chat
ARCHESTRA_CHAT_GROQ_API_KEY=<your_groq_api_key>
```

## API Key Setup

1. Sign in to https://console.groq.com/
2. Create an API key in the API Keys section
3. Store it as `ARCHESTRA_CHAT_GROQ_API_KEY`

## Minimal Smoke Test

After wiring routes and adapters, verify with a chat completions call:

```bash
curl -sS http://localhost:9000/v1/groq/chat/completions \
  -H "Authorization: Bearer $ARCHESTRA_CHAT_GROQ_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "llama-3.3-70b-versatile",
    "messages": [{"role":"user","content":"Say pong"}],
    "stream": false
  }'
```

Expected: HTTP 200 and one assistant message in the response payload.

## Recommended Code Starting Points

Because Groq uses an OpenAI-compatible API shape, bootstrap from these existing providers:

- `platform/backend/src/routes/proxy/routesv2/vllm.ts`
- `platform/backend/src/routes/proxy/adapterV2/vllm.ts`
- `platform/backend/src/routes/proxy/routesv2/zhipuai.ts`
- `platform/backend/src/routes/proxy/adapterV2/zhipuai.ts`

## Acceptance Draft

A minimal first PR for issue #1856 should include:

1. Proxy route registration for `groq`
2. Adapter factory + request/response/stream adapters wired for chat completions
3. Chat provider registration in settings/model selector
4. One e2e mapping + one API smoke test

This is intentionally a draft artifact to accelerate review alignment before full implementation.
