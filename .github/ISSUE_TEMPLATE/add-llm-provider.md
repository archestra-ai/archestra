---
name: Add LLM Provider
about: Request or propose adding a new LLM provider to Archestra
title: "[Provider] Add <Provider Name> support"
labels: enhancement, provider
assignees: ''

---

**Provider Name:** <!-- e.g., Mistral, Cohere, Together AI -->

**Provider Website:** <!-- Link to the provider's main page -->

**API Documentation:** <!-- Link to the provider's API docs -->

## Implementation Checklist

Adding a new provider involves integrating it into both **LLM Proxy** and **Chat**. For detailed guidance, see our [Adding LLM Providers documentation](/docs/platform-adding-llm-providers).

## Requirements

When submitting a PR to add this provider, please ensure:

### 1. API Key Instructions
Include clear instructions on how to obtain an API key for testing. This helps reviewers verify the integration works correctly.

### 2. Streaming Support
- [ ] Non-streaming responses work correctly
- [ ] Streaming responses work correctly (if supported by the provider)

If the provider doesn't support streaming, document this limitation.

### 3. Feature Completeness

**LLM Proxy:**
- Tool invocation and persistence
- Token/cost limits
- Model optimization
- Tool results compression
- Dual LLM verification
- Metrics and observability

**Chat:**
- Chat conversations works
- Model listing and selection
- Streaming responses
- Error handling

Chat functionality requires [Vercel AI SDK](https://ai-sdk.dev/providers/ai-sdk-providers) support. Please check if the provider is available — if not, note this in the PR so we can plan accordingly.

### 4. Demo Video
Please include a short demo video showing:
- Non-streaming response in action
- Streaming response in action (if supported)

### 5. Documentation
Update the [Supported LLM Providers](https://archestra.ai/docs/platform-supported-llm-providers) page to include the new provider.

## Additional Context

<!--
Any other information that might be helpful:
- Are you planning to implement this yourself?
- Do you have access to test the provider?
- Any known limitations or considerations?
-->
