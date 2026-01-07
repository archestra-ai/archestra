#!/usr/bin/env python3
"""
Entrypoint script for the Archestra Coding Agent.

This script registers custom Git and GitHub tools with Serena's ToolRegistry
before starting the MCP server.

The key insight is that Serena's ToolRegistry is a singleton that scans for
Tool subclasses only from packages listed in `tool_packages`. We need to:
1. Add our package to `tool_packages` BEFORE ToolRegistry is instantiated
2. Import our tools (so they're discovered as Tool subclasses)
3. Then start the MCP server with proper context and project settings
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
    "github_create_pr",
    "github_list_prs",
    "github_get_issue",
]
logger.info(f"Registered {len(custom_tools)} custom tools: {custom_tools}")

# Now start the Serena MCP server using the CLI
if __name__ == "__main__":
    from serena.cli import start_mcp_server
    
    # Build CLI arguments for Serena
    # See: https://oraios.github.io/serena/02-usage/050_configuration.html#contexts
    args = sys.argv[1:] if len(sys.argv) > 1 else []
    
    # Default Serena configuration for coding agent:
    # - context "agent": Designed for autonomous agent scenarios
    # - mode "interactive" + "editing": Default modes for back-and-forth editing
    # - mode "no-onboarding": Skip onboarding since we clone repos dynamically
    # - project /workspace: Set default project so tools don't fail with "No active project"
    #
    # These can be overridden by passing CLI args to the container
    default_args = [
        "--context", "agent",
        "--mode", "interactive",
        "--mode", "editing", 
        "--mode", "no-onboarding",
    ]
    
    # Check if /workspace has a git repo (cloned by git_clone tool)
    # If so, set it as the default project
    workspace_dir = os.environ.get("WORKSPACE_DIR", "/workspace")
    if os.path.isdir(workspace_dir):
        # Find first git repo in workspace
        for item in os.listdir(workspace_dir):
            item_path = os.path.join(workspace_dir, item)
            if os.path.isdir(item_path) and os.path.isdir(os.path.join(item_path, ".git")):
                default_args.extend(["--project", item_path])
                logger.info(f"Auto-detected project: {item_path}")
                break
    
    # Merge: user args take precedence over defaults
    # Simple approach: prepend defaults, let Serena handle overrides
    final_args = default_args + args
    
    logger.info(f"Starting Serena MCP server with args: {final_args}")
    
    # Use click to invoke the command with proper argument parsing
    try:
        start_mcp_server.main(final_args, standalone_mode=True)
    except SystemExit as e:
        sys.exit(e.code)

