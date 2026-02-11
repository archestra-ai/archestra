# Groq Provider for Archestra

## Overview

This provider integrates Groq's high-performance LLM API with Archestra's LLM Proxy and Chat systems.

## Features

- ✅ Non-streaming responses
- ✅ Streaming responses
- ✅ Tool invocation
- ✅ Token/cost tracking
- ✅ Error handling

## Configuration

### API Key

Get your API key from [Groq Console](https://console.groq.com/keys)

### Environment Variables

```bash
GROQ_API_KEY=gsk_xxx
```

## Usage

```typescript
import { createGroq } from '@archestra/groq';

const groq = createGroq({
  apiKey: process.env.GROQ_API_KEY,
});

// Non-streaming
const response = await groq.chat.completions.create({
  model: 'llama-3.1-70b-versatile',
  messages: [{ role: 'user', content: 'Hello!' }],
});

// Streaming
const stream = await groq.chat.completions.create({
  model: 'llama-3.1-70b-versatile',
  messages: [{ role: 'user', content: 'Hello!' }],
  stream: true,
});
```

## Supported Models

- `llama-3.1-70b-versatile`
- `llama-3.1-8b-instant`
- `mixtral-8x7b-32768`
- `gemma-7b-it`

## Implementation

See `src/providers/groq/` for the full implementation.

## Testing

```bash
npm test -- providers/groq
```

## License

MIT
