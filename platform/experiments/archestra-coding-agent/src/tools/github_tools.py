"""
GitHub tools for the Archestra Coding Agent.

These tools provide GitHub API operations (PRs, issues) that complement
Serena's semantic code editing and Git tools.
"""

import json
import os
import re
from typing import Optional

from serena.tools import Tool
from serena.tools.tools_base import ToolMarkerDoesNotRequireActiveProject

# Try to import PyGithub, but provide a fallback error message
try:
    from github import Github, GithubException
    GITHUB_AVAILABLE = True
except ImportError:
    GITHUB_AVAILABLE = False
    Github = None
    GithubException = Exception


# Regex to validate GitHub URLs - must start with https://github.com/ or git@github.com:
GITHUB_URL_PATTERN = re.compile(
    r"^(?:https?://)?(?:www\.)?github\.com/([a-zA-Z0-9_.-]+)/([a-zA-Z0-9_.-]+?)(?:\.git)?/?$"
)
GITHUB_SSH_PATTERN = re.compile(
    r"^git@github\.com:([a-zA-Z0-9_.-]+)/([a-zA-Z0-9_.-]+?)(?:\.git)?$"
)
# Pattern for owner/repo format (no URL)
OWNER_REPO_PATTERN = re.compile(
    r"^([a-zA-Z0-9_.-]+)/([a-zA-Z0-9_.-]+)$"
)


def _get_github_client() -> Optional["Github"]:
    """
    Get a GitHub client using the GITHUB_TOKEN environment variable.

    Returns:
        Github client instance, or None if token not configured
    """
    if not GITHUB_AVAILABLE:
        return None

    token = os.environ.get("GITHUB_TOKEN")
    if not token:
        return None

    return Github(token)


def _get_github_error_message(e: "GithubException") -> str:
    """
    Safely extract error message from GithubException.

    PyGithub's GithubException.data can be None, a string, or a dict.
    This helper handles all cases gracefully.

    Args:
        e: The GithubException instance

    Returns:
        Human-readable error message
    """
    if e.data is None:
        return str(e)
    if isinstance(e.data, dict):
        return e.data.get("message", str(e))
    # e.data is a string or other type
    return str(e.data) if e.data else str(e)


def _parse_repo_info(repo_url: Optional[str] = None) -> tuple[Optional[str], Optional[str]]:
    """
    Parse owner and repo name from a repository URL or path.

    Uses strict regex patterns to prevent URL injection attacks.
    Only accepts:
    - https://github.com/owner/repo
    - git@github.com:owner/repo
    - owner/repo format

    Args:
        repo_url: GitHub URL (https://github.com/owner/repo) or owner/repo format

    Returns:
        Tuple of (owner, repo_name), or (None, None) if parsing fails
    """
    if repo_url is None:
        return None, None

    # Strip whitespace
    repo_url = repo_url.strip()

    # Try HTTPS URL pattern (must start with github.com domain)
    match = GITHUB_URL_PATTERN.match(repo_url)
    if match:
        return match.group(1), match.group(2)

    # Try SSH URL pattern
    match = GITHUB_SSH_PATTERN.match(repo_url)
    if match:
        return match.group(1), match.group(2)

    # Try simple owner/repo format (no URL)
    match = OWNER_REPO_PATTERN.match(repo_url)
    if match:
        return match.group(1), match.group(2)

    return None, None


class GithubCreatePrTool(Tool, ToolMarkerDoesNotRequireActiveProject):
    """Create a pull request on GitHub."""

    def apply(
        self,
        title: str,
        body: str,
        head: str,
        base: str = "main",
        repo: Optional[str] = None,
        draft: bool = False,
    ) -> str:
        """
        Create a pull request on GitHub.

        :param title: Title of the pull request
        :param body: Description/body of the pull request
        :param head: The branch containing your changes (source branch)
        :param base: The branch you want to merge into (target branch, default: main)
        :param repo: Repository in 'owner/repo' format or full GitHub URL
        :param draft: Create as draft PR (default: False)
        :return: JSON result with PR information
        """
        if not GITHUB_AVAILABLE:
            return json.dumps({
                "success": False,
                "error": "PyGithub is not installed. Please install it with: pip install PyGithub",
            })

        client = _get_github_client()
        if client is None:
            return json.dumps({
                "success": False,
                "error": "GITHUB_TOKEN environment variable not set. Please configure it.",
            })

        owner, repo_name = _parse_repo_info(repo)
        if owner is None or repo_name is None:
            return json.dumps({
                "success": False,
                "error": "Could not parse repository. Provide repo in 'owner/repo' format.",
            })

        try:
            gh_repo = client.get_repo(f"{owner}/{repo_name}")
            pr = gh_repo.create_pull(
                title=title,
                body=body,
                head=head,
                base=base,
                draft=draft,
            )

            return json.dumps({
                "success": True,
                "pr_number": pr.number,
                "pr_url": pr.html_url,
                "title": pr.title,
                "state": pr.state,
                "head": head,
                "base": base,
                "message": f"Successfully created PR #{pr.number}: {pr.html_url}",
            })
        except GithubException as e:
            return json.dumps({
                "success": False,
                "error": f"GitHub API error: {_get_github_error_message(e)}",
                "status": e.status,
            })
        except Exception as e:
            return json.dumps({
                "success": False,
                "error": str(e),
            })


class GithubListPrsTool(Tool, ToolMarkerDoesNotRequireActiveProject):
    """List pull requests for a repository."""

    def apply(
        self,
        repo: str,
        state: str = "open",
        limit: int = 10,
    ) -> str:
        """
        List pull requests for a GitHub repository.

        :param repo: Repository in 'owner/repo' format or full GitHub URL
        :param state: Filter by state: 'open', 'closed', or 'all' (default: open)
        :param limit: Maximum number of PRs to return (default: 10)
        :return: JSON result with list of PRs
        """
        if not GITHUB_AVAILABLE:
            return json.dumps({
                "success": False,
                "error": "PyGithub is not installed. Please install it with: pip install PyGithub",
            })

        client = _get_github_client()
        if client is None:
            return json.dumps({
                "success": False,
                "error": "GITHUB_TOKEN environment variable not set. Please configure it.",
            })

        owner, repo_name = _parse_repo_info(repo)
        if owner is None or repo_name is None:
            return json.dumps({
                "success": False,
                "error": "Could not parse repository. Provide repo in 'owner/repo' format.",
            })

        try:
            gh_repo = client.get_repo(f"{owner}/{repo_name}")
            pulls = gh_repo.get_pulls(state=state, sort="updated", direction="desc")

            pr_list = []
            for pr in pulls[:limit]:
                pr_list.append({
                    "number": pr.number,
                    "title": pr.title,
                    "state": pr.state,
                    "url": pr.html_url,
                    "author": pr.user.login if pr.user else "unknown",
                    "head": pr.head.ref,
                    "base": pr.base.ref,
                    "created_at": pr.created_at.isoformat() if pr.created_at else None,
                    "updated_at": pr.updated_at.isoformat() if pr.updated_at else None,
                    "draft": pr.draft,
                })

            return json.dumps({
                "success": True,
                "repo": f"{owner}/{repo_name}",
                "state": state,
                "count": len(pr_list),
                "pull_requests": pr_list,
            })
        except GithubException as e:
            return json.dumps({
                "success": False,
                "error": f"GitHub API error: {_get_github_error_message(e)}",
                "status": e.status,
            })
        except Exception as e:
            return json.dumps({
                "success": False,
                "error": str(e),
            })


class GithubGetIssueTool(Tool, ToolMarkerDoesNotRequireActiveProject):
    """Get details of a GitHub issue."""

    def apply(
        self,
        repo: str,
        issue_number: int,
        include_comments: bool = False,
        max_comments: int = 10,
    ) -> str:
        """
        Get details of a GitHub issue.

        :param repo: Repository in 'owner/repo' format or full GitHub URL
        :param issue_number: The issue number
        :param include_comments: Whether to include issue comments (default: False)
        :param max_comments: Maximum number of comments to include (default: 10)
        :return: JSON result with issue details
        """
        if not GITHUB_AVAILABLE:
            return json.dumps({
                "success": False,
                "error": "PyGithub is not installed. Please install it with: pip install PyGithub",
            })

        client = _get_github_client()
        if client is None:
            return json.dumps({
                "success": False,
                "error": "GITHUB_TOKEN environment variable not set. Please configure it.",
            })

        owner, repo_name = _parse_repo_info(repo)
        if owner is None or repo_name is None:
            return json.dumps({
                "success": False,
                "error": "Could not parse repository. Provide repo in 'owner/repo' format.",
            })

        try:
            gh_repo = client.get_repo(f"{owner}/{repo_name}")
            issue = gh_repo.get_issue(number=issue_number)

            # Get labels
            labels = [label.name for label in issue.labels]

            # Get assignees
            assignees = [a.login for a in issue.assignees] if issue.assignees else []

            result = {
                "success": True,
                "number": issue.number,
                "title": issue.title,
                "state": issue.state,
                "url": issue.html_url,
                "body": issue.body,
                "author": issue.user.login if issue.user else "unknown",
                "labels": labels,
                "assignees": assignees,
                "created_at": issue.created_at.isoformat() if issue.created_at else None,
                "updated_at": issue.updated_at.isoformat() if issue.updated_at else None,
                "closed_at": issue.closed_at.isoformat() if issue.closed_at else None,
                "comments_count": issue.comments,
            }

            # Optionally include comments
            if include_comments and issue.comments > 0:
                comments = []
                for comment in issue.get_comments()[:max_comments]:
                    comments.append({
                        "id": comment.id,
                        "author": comment.user.login if comment.user else "unknown",
                        "body": comment.body,
                        "created_at": comment.created_at.isoformat() if comment.created_at else None,
                    })
                result["comments"] = comments

            return json.dumps(result)
        except GithubException as e:
            return json.dumps({
                "success": False,
                "error": f"GitHub API error: {_get_github_error_message(e)}",
                "status": e.status,
            })
        except Exception as e:
            return json.dumps({
                "success": False,
                "error": str(e),
            })

