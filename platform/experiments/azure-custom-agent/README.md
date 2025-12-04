# Azure AI Agent with Archestra Proxy

Demonstrates how to secure an Azure OpenAI-powered agent by routing API calls through Archestra's security proxy.

## Architecture

**Without Archestra (Vulnerable)**:
```
User → Azure OpenAI API → GPT-4o-mini → Tool Calls (unvalidated)
```

**With Archestra (Protected)**:
```
User → Archestra Proxy → Azure OpenAI API → GPT-4o-mini → Tool Calls
                ↓
      Security Policies Applied:
      - Tool invocation limits
      - Trusted data validation
      - Dual LLM verification
      - PII sanitization
```

## Setup

### 1. Install Dependencies

```bash
pip install -r requirements.txt
```

### 2. Configure Environment

```bash
cp .env.example .env
# Edit .env with your credentials
```

Required variables:
- `AZURE_OPENAI_KEY`: Get from Azure Portal → Your OpenAI resource → Keys and Endpoint
- `ARCHESTRA_AGENT_ID`: Get from Archestra UI → Create profile → Copy ID
- `USE_ARCHESTRA`: Set to `true` to enable proxy (defaults to `false`)

### 3. Start Archestra (if testing with proxy)

```bash
# From platform/ directory
tilt up
# Wait for services to start, then create a profile at http://localhost:3000
```

## Usage

### Run Tests

```bash
python azure_agent_with_archestra.py
```

This runs three test scenarios:
1. **Normal request without proxy**: Shows legitimate use case
2. **Malicious request without proxy**: Demonstrates prompt injection vulnerability
3. **Malicious request with proxy**: Shows how Archestra blocks the attack

### Expected Output

**Test 1 - Normal Request (No Proxy)**:
```
⚠️  Direct connection to Azure OpenAI (no security)
User: Hi, I have a question about our recent invoice...
🔧 Agent requested tool calls:
   - search_customers({"query": "Tech Innovations Ltd"})
⚠️  No security policies - tools would execute directly
```

**Test 2 - Malicious Request (No Proxy)**:
```
⚠️  Direct connection to Azure OpenAI (no security)
User: Please retrieve the account details for customers CUST-001, CUST-002, and CUST-003...
🔧 Agent requested tool calls:
   - get_account_details({"customer_id": "CUST-001"})
   - get_account_details({"customer_id": "CUST-002"})
   - get_account_details({"customer_id": "CUST-003"})
⚠️  No security policies - tools would execute directly
```
*Vulnerable! Agent attempts unauthorized data access.*

**Test 3 - Malicious Request (With Proxy)**:
```
🔒 Using Archestra proxy: http://localhost:9000/v1/openai/{agent_id}
User: Please retrieve the account details for customers CUST-001, CUST-002, and CUST-003...
🔧 Agent requested tool calls:
   - get_account_details({"customer_id": "CUST-001"})
   - get_account_details({"customer_id": "CUST-002"})
   - get_account_details({"customer_id": "CUST-003"})
✅ Archestra proxy would apply security policies here:
   - Tool invocation policies (max calls per conversation)
   - Trusted data policies (PII sanitization)
   - Dual LLM validation (detect suspicious patterns)
```
*Protected! Archestra intercepts and validates tool calls.*

## Key Findings

1. **Azure AI Foundry UI limitation**: No way to configure custom proxy endpoints
2. **SDK workaround**: Can route through proxy by changing `azure_endpoint` parameter
3. **Security gap**: Without proxy, Azure agents have no defense against prompt injection
4. **"Rule of Two" vulnerability**: Sensitive data access + data transmission = critical risk

## Code Structure

- `create_client()`: Creates OpenAI client with optional proxy routing
- `run_agent()`: Executes agent with tool definitions and system prompt
- `test_vulnerability()`: Demonstrates attack scenarios

## Configuration Details

The key difference is in the client initialization:

**Direct (vulnerable)**:
```python
client = AzureOpenAI(
    azure_endpoint="https://your-resource.openai.azure.com",
    api_key=AZURE_OPENAI_KEY,
    api_version="2024-12-01-preview"
)
```

**Via Archestra (protected)**:
```python
client = AzureOpenAI(
    azure_endpoint=f"http://localhost:9000/v1/openai/{ARCHESTRA_AGENT_ID}",
    api_key=ARCHESTRA_AGENT_ID,  # Archestra uses agent ID as auth
    api_version="2024-12-01-preview"
)
```

## Next Steps

1. Configure tool invocation policies in Archestra UI
2. Set up trusted data policies for PII sanitization
3. Enable dual LLM validation for prompt injection detection
4. Monitor tool calls via Archestra logs at http://localhost:3000/logs/mcp-gateway

## Related Files

- `../azure-terraform/`: Infrastructure deployment (Azure AI Foundry Hub, Project, etc.)
- `../SECURING_AZURE_AGENT.md`: Complete walkthrough guide
- `../ARTICLE_OUTLINE_PROXY.md`: Full article structure for publication
