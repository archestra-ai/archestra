"""
Tool registration script for the Archestra Coding Agent.

This script registers all custom Git and GitHub tools with Serena's tool registry.
It should be imported when starting the MCP server to make the tools available.
"""

import logging
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from serena.tools import ToolRegistry

logger = logging.getLogger(__name__)


def register_custom_tools() -> None:
    """
    Register all custom tools with Serena's ToolRegistry.
    
    This function imports and registers the Git and GitHub tools,
    making them available to the Serena agent.
    """
    try:
        from serena.tools import ToolRegistry
    except ImportError:
        logger.warning(
            "Serena not installed. Custom tools cannot be registered. "
            "Install Serena to use the full functionality."
        )
        return

    registry = ToolRegistry()

    # Import and register Git tools
    from .tools.git_tools import (
        GitCloneTool,
        GitStatusTool,
        GitDiffTool,
        GitCommitTool,
        GitPushTool,
        GitCheckoutBranchTool,
    )

    git_tools = [
        GitCloneTool,
        GitStatusTool,
        GitDiffTool,
        GitCommitTool,
        GitPushTool,
        GitCheckoutBranchTool,
    ]

    for tool_class in git_tools:
        try:
            registry.register_tool_class(tool_class)
            logger.info(f"Registered Git tool: {tool_class.__name__}")
        except Exception as e:
            logger.error(f"Failed to register {tool_class.__name__}: {e}")

    # Import and register GitHub tools
    from .tools.github_tools import (
        GitHubCreatePRTool,
        GitHubListPRsTool,
        GitHubGetIssueTool,
    )

    github_tools = [
        GitHubCreatePRTool,
        GitHubListPRsTool,
        GitHubGetIssueTool,
    ]

    for tool_class in github_tools:
        try:
            registry.register_tool_class(tool_class)
            logger.info(f"Registered GitHub tool: {tool_class.__name__}")
        except Exception as e:
            logger.error(f"Failed to register {tool_class.__name__}: {e}")

    logger.info("Custom tool registration complete!")


# Auto-register when this module is imported
if __name__ != "__main__":
    register_custom_tools()

