#!/usr/bin/env python3
"""
Entrypoint script for the Archestra Coding Agent.

This script registers custom Git and GitHub tools with Serena's ToolRegistry
before starting the MCP server.

The key insight is that Serena's ToolRegistry is a singleton that scans for
Tool subclasses only from packages listed in `tool_packages`. We need to:
1. Add our package to `tool_packages` BEFORE ToolRegistry is instantiated
2. Import our tools (so they're discovered as Tool subclasses)
3. Then start the MCP server
"""

import sys
import os

# Add our custom tools path to Python path
custom_tools_path = os.environ.get("SERENA_CUSTOM_TOOLS_PATH", "/app/custom_tools")
if custom_tools_path not in sys.path:
    sys.path.insert(0, custom_tools_path)

# CRITICAL: Modify tool_packages BEFORE importing ToolRegistry
# This must happen before any Serena imports that trigger ToolRegistry instantiation
import serena.tools.tools_base as tools_base
tools_base.tool_packages.append("src.tools")

# Now import our custom tools - this makes them discoverable as Tool subclasses
# The imports must happen AFTER modifying tool_packages but BEFORE ToolRegistry is used
from src.tools import git_tools  # noqa: F401, E402
from src.tools import github_tools  # noqa: F401, E402

# Log what tools we've registered
import logging
logging.basicConfig(level=logging.INFO, stream=sys.stderr)
logger = logging.getLogger(__name__)

# List the custom tool classes that were imported
custom_tools = [
    # Git tools
    "git_clone",
    "git_status", 
    "git_diff",
    "git_commit",
    "git_push",
    "git_checkout_branch",
    # GitHub tools
    "git_hub_create_pr",
    "git_hub_list_prs",
    "git_hub_get_issue",
]
logger.info(f"Registered {len(custom_tools)} custom tools: {custom_tools}")

# Now start the Serena MCP server using the CLI
if __name__ == "__main__":
    from serena.cli import start_mcp_server
    import click
    
    # Get the context from click and invoke the command
    ctx = click.Context(start_mcp_server)
    
    # Pass through any CLI arguments
    args = sys.argv[1:] if len(sys.argv) > 1 else []
    
    # Use click to invoke the command with proper argument parsing
    try:
        start_mcp_server.main(args, standalone_mode=True)
    except SystemExit as e:
        sys.exit(e.code)

