# Experiments

## 🔒 Securing Azure AI Agents with Archestra Proxy

**NEW**: Following the [Mastra security pattern](https://archestra.ai/docs/platform-mastra-example) to secure Azure AI Foundry agents.

### The Approach

1. **Deploy vulnerable Azure agent** (with Terraform)
2. **Demonstrate the attack** (prompt injection succeeds)
3. **Route through Archestra proxy** (one environment variable)
4. **Add security policies** (UI configuration)
5. **Re-test attack** (now blocked by Archestra)

### Quick Links

**Main Guide**: **[Securing Azure Agent](SECURING_AZURE_AGENT.md)** - Complete walkthrough (37 minutes)

**Supporting Docs**:
- [Article Outline](ARTICLE_OUTLINE_PROXY.md) - Full article structure for publication
- [Azure Terraform Deployment](azure-terraform/DEPLOYMENT_GUIDE.md) - Infrastructure setup
- [Archestra Setup](VULNERABLE_AGENT_DEMO.md) - Local MCP servers

### What's Included

- ✅ Azure Terraform deployment (AI Foundry + Functions + Logic Apps)
- ✅ Mock CRM MCP server (simulates Salesforce)
- ✅ Mock Email MCP server (sending capability)
- ✅ Proxy configuration (routes Azure agent through Archestra)
- ✅ Security policies (tool invocation, trusted data, dual LLM)
- ✅ Attack scenarios (prompt injection demonstrations)

### Key Results

| Metric | Azure Alone | + Archestra Proxy |
|--------|-------------|------------------|
| Setup Time | 10 min | +27 min (total 37 min) |
| Security Controls | 0/9 | 9/9 |
| Attack Success | 100% | 0% |
| Additional Cost | $0 | $0 (self-hosted) |
| Code Changes | N/A | 0 (just env var) |

---

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
