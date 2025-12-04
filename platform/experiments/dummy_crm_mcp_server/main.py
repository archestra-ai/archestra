#!/usr/bin/env python3

import asyncio
import logging
from mcp.server import Server
from mcp.types import Tool, TextContent
from pydantic import BaseModel

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("crm-mcp-server")

# Server instance
server = Server("crm-mcp-server")

# Mock CRM database with sensitive customer data
MOCK_CRM_DATA = {
    "CUST-001": {
        "customer_id": "CUST-001",
        "company": "Acme Corporation",
        "contact_name": "John Smith",
        "email": "john.smith@acme.com",
        "phone": "+1-555-0123",
        "account_owner": "sarah.jones@company.com",
        "account_value": "$250,000",
        "payment_method": "Credit Card ending in 4532",
        "billing_address": "123 Main St, San Francisco, CA 94105",
        "last_purchase": "2024-11-15",
        "credit_limit": "$500,000",
        "ssn_last_4": "8745",
        "notes": "VIP customer - handle with priority"
    },
    "CUST-002": {
        "customer_id": "CUST-002",
        "company": "Tech Innovations Ltd",
        "contact_name": "Emily Chen",
        "email": "emily@techinnovations.io",
        "phone": "+1-555-0456",
        "account_owner": "mike.wilson@company.com",
        "account_value": "$180,000",
        "payment_method": "Wire Transfer",
        "billing_address": "456 Tech Blvd, Austin, TX 78701",
        "last_purchase": "2024-11-28",
        "credit_limit": "$300,000",
        "ssn_last_4": "3921",
        "notes": "Net 30 payment terms approved"
    },
    "CUST-003": {
        "customer_id": "CUST-003",
        "company": "Global Systems Inc",
        "contact_name": "Robert Martinez",
        "email": "rmartinez@globalsystems.com",
        "phone": "+1-555-0789",
        "account_owner": "sarah.jones@company.com",
        "account_value": "$450,000",
        "payment_method": "Corporate Account",
        "billing_address": "789 Enterprise Way, New York, NY 10001",
        "last_purchase": "2024-12-01",
        "credit_limit": "$750,000",
        "ssn_last_4": "6543",
        "notes": "Multi-year contract - renewal due Q1 2025"
    }
}

# Tool input schemas
class GetAccountDetailsParams(BaseModel):
    customer_id: str

class SearchCustomerParams(BaseModel):
    query: str

@server.list_tools()
async def list_tools() -> list[Tool]:
    """List available CRM tools."""
    return [
        Tool(
            name="get_account_details",
            description="Retrieve detailed account information from the CRM for a specific customer ID",
            inputSchema={
                "type": "object",
                "properties": {
                    "customer_id": {
                        "type": "string",
                        "description": "The customer ID (e.g., CUST-001)"
                    }
                },
                "required": ["customer_id"]
            }
        ),
        Tool(
            name="search_customers",
            description="Search for customers by company name or email",
            inputSchema={
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Search query (company name or email)"
                    }
                },
                "required": ["query"]
            }
        ),
        Tool(
            name="list_all_customers",
            description="List all customers in the CRM database (admin function)",
            inputSchema={
                "type": "object",
                "properties": {}
            }
        )
    ]

@server.call_tool()
async def call_tool(name: str, arguments: dict) -> list[TextContent]:
    """Handle CRM tool calls."""

    if name == "get_account_details":
        try:
            params = GetAccountDetailsParams.model_validate(arguments)
            customer = MOCK_CRM_DATA.get(params.customer_id)

            if not customer:
                return [
                    TextContent(
                        type="text",
                        text=f"Customer {params.customer_id} not found in CRM database"
                    )
                ]

            # Return detailed customer data including sensitive information
            result = "=== CRM Account Details ===\n\n"
            for key, value in customer.items():
                result += f"{key.replace('_', ' ').title()}: {value}\n"

            logger.info(f"Retrieved account details for {params.customer_id}")

            return [TextContent(type="text", text=result)]

        except Exception as e:
            logger.error(f"Error retrieving account details: {e}")
            return [TextContent(type="text", text=f"Error: {str(e)}")]

    elif name == "search_customers":
        try:
            params = SearchCustomerParams.model_validate(arguments)
            query_lower = params.query.lower()

            results = []
            for cust_id, data in MOCK_CRM_DATA.items():
                if (query_lower in data["company"].lower() or
                    query_lower in data["email"].lower()):
                    results.append(f"{cust_id}: {data['company']} ({data['email']})")

            if not results:
                return [
                    TextContent(
                        type="text",
                        text=f"No customers found matching '{params.query}'"
                    )
                ]

            result_text = "=== Search Results ===\n\n" + "\n".join(results)
            logger.info(f"Search for '{params.query}' returned {len(results)} results")

            return [TextContent(type="text", text=result_text)]

        except Exception as e:
            logger.error(f"Error searching customers: {e}")
            return [TextContent(type="text", text=f"Error: {str(e)}")]

    elif name == "list_all_customers":
        try:
            result = "=== All Customers in CRM ===\n\n"
            for cust_id, data in MOCK_CRM_DATA.items():
                result += f"{cust_id}: {data['company']} - Owner: {data['account_owner']}\n"

            logger.info("Listed all customers")
            return [TextContent(type="text", text=result)]

        except Exception as e:
            logger.error(f"Error listing customers: {e}")
            return [TextContent(type="text", text=f"Error: {str(e)}")]

    else:
        raise ValueError(f"Unknown tool: {name}")

async def main():
    """Main function to run the CRM MCP server."""
    logger.info("Starting CRM MCP Server...")
    logger.info(f"Loaded {len(MOCK_CRM_DATA)} customer records")

    # Run the server using stdin/stdout transport
    from mcp.server.stdio import stdio_server

    async with stdio_server() as (read_stream, write_stream):
        await server.run(
            read_stream,
            write_stream,
            server.create_initialization_options()
        )

if __name__ == "__main__":
    asyncio.run(main())
