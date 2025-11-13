#!/usr/bin/env python3

import asyncio
import sys
import json
import logging
from mcp.server import Server
from mcp.types import Tool, TextContent
from pydantic import BaseModel

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("email-mcp-server")

# Server instance
server = Server("email-mcp-server")

# Tool input schema
class SendEmailParams(BaseModel):
    to: str
    subject: str
    body: str

@server.list_tools()
async def list_tools() -> list[Tool]:
    """List available tools."""
    return [
        Tool(
            name="send_email",
            description="Send an email (mock implementation for testing)",
            inputSchema={
                "type": "object",
                "properties": {
                    "to": {
                        "type": "string",
                        "description": "The email address to send the email to"
                    },
                    "subject": {
                        "type": "string",
                        "description": "The subject of the email"
                    },
                    "body": {
                        "type": "string",
                        "description": "The body of the email"
                    }
                },
                "required": ["to", "subject", "body"]
            }
        )
    ]

@server.call_tool()
async def call_tool(name: str, arguments: dict) -> list[TextContent]:
    """Handle tool calls."""
    if name == "send_email":
        try:
            params = SendEmailParams.model_validate(arguments)
            
            # Mock implementation - just log and return success
            logger.info(
                f"Mock email sent - To: {params.to}, Subject: {params.subject}, Body length: {len(params.body)}"
            )
            
            return [
                TextContent(
                    type="text",
                    text=f"Mock email sent successfully!\n\nTo: {params.to}\nSubject: {params.subject}\nBody: {params.body[:100]}{'...' if len(params.body) > 100 else ''}"
                )
            ]
        except Exception as e:
            logger.error(f"Error sending mock email: {e}")
            return [
                TextContent(
                    type="text", 
                    text=f"Error sending email: {str(e)}"
                )
            ]
    else:
        raise ValueError(f"Unknown tool: {name}")

async def main():
    """Main function to run the MCP server."""
    logger.info("Starting Email MCP Server...")
    
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
