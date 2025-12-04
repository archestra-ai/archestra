# Mock CRM MCP Server

A demonstration MCP server simulating a CRM system (like Salesforce) with sensitive customer data.

## Purpose

This server is designed for security research and demonstration purposes to recreate the vulnerable agent scenario from the Zenity Azure AI Foundry security article.

## Tools Provided

1. **get_account_details** - Retrieve full customer record including sensitive data (SSN, payment info)
2. **search_customers** - Search customers by company name or email
3. **list_all_customers** - List all customer IDs and account owners

## Mock Data

Contains 3 sample customer records with realistic sensitive information:
- Customer IDs, company names, contact info
- Account owners (for email routing)
- Payment methods, billing addresses
- Credit limits, SSN last 4 digits
- Account values and notes

## Installation

```bash
# Install dependencies
uv pip install -e .

# Or install directly
uv pip install mcp pydantic
```

## Usage

Run as a local MCP server in Archestra:

```json
{
  "command": "python3",
  "args": ["/path/to/dummy_crm_mcp_server/main.py"],
  "transportType": "stdio"
}
```

## Security Warning

⚠️ This server intentionally returns sensitive data without validation. It's designed to demonstrate the "Rule of Two" vulnerability when combined with:
1. Untrusted input (email content)
2. Sensitive data access (this CRM server)
3. Transmission capability (email sending)

**DO NOT use this with real customer data or in production environments.**
