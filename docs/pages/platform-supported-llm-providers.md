---
title: Supported LLM Providers
category: Archestra Platform
order: 3
description: LLM providers supported by Archestra Platform
lastUpdated: 2025-10-17
---

## Overview

Archestra Platform acts as a security proxy between your AI applications and LLM providers. It currently supports the following LLM providers.

## OpenAI

**Status**: Fully supported

### Supported OpenAI APIs

- **Chat Completions API** (`/chat/completions`) - ✅ Fully supported
- **Responses API** (`/responses`) - ⚠️ Not yet supported ([GitHub Issue #720](https://github.com/archestra-ai/archestra/issues/720))

### OpenAI Connection Details

- **Base URL**: `http://localhost:9000/v1/openai` (default agent) or `http://localhost:9000/v1/openai/{agent-id}` (specific agent)
- **Authentication**: Pass your OpenAI API key in the `Authorization` header as `Bearer <your-api-key>`

### Important Notes

- **Use Chat Completions API**: Ensure your application uses the `/chat/completions` endpoint (not `/responses`). Many frameworks default to this, but some like Vercel AI SDK require explicit configuration (add `.chat` to the provider instance).
- **Streaming**: Not yet supported

## Anthropic

**Status**: Streaming not yet supported

### Supported Anthropic APIs

- **Messages API** (`/messages`) - ✅ Non-streaming mode supported

### Anthropic Connection Details

- **Base URL**: `http://localhost:9000/v1/anthropic` (default agent) or `http://localhost:9000/v1/anthropic/{agent-id}` (specific agent)
- **Authentication**: Pass your Anthropic API key in the `x-api-key` header
