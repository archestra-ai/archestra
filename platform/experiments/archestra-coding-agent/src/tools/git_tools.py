"""
Git tools for the Archestra Coding Agent.

These tools provide Git operations (clone, status, diff, commit, push, branch)
that extend Serena's semantic code editing capabilities.
"""

import json
import os
import subprocess
from typing import Optional

from serena.tools import Tool
from serena.tools.tools_base import ToolMarkerDoesNotRequireActiveProject

# Default workspace directory for cloned repositories
DEFAULT_WORKSPACE_DIR = os.environ.get("WORKSPACE_DIR", "/workspace")


def _sanitize_path(target_dir: str, base_dir: str = DEFAULT_WORKSPACE_DIR) -> tuple[str, Optional[str]]:
    """
    Sanitize and validate a target directory path to prevent path traversal attacks.

    Args:
        target_dir: The target directory name or relative path
        base_dir: The base directory that target_dir must stay within

    Returns:
        Tuple of (sanitized_full_path, error_message)
        If error_message is not None, the path is invalid
    """
    # Reject absolute paths
    if os.path.isabs(target_dir):
        return "", f"Absolute paths are not allowed. Use a relative directory name instead of '{target_dir}'"

    # Normalize the base directory
    base_dir = os.path.abspath(base_dir)

    # Join and normalize the full path
    full_path = os.path.normpath(os.path.join(base_dir, target_dir))

    # Verify the resolved path is within the base directory
    # Use os.path.commonpath to check containment
    try:
        common = os.path.commonpath([base_dir, full_path])
        if common != base_dir:
            return "", f"Path traversal detected. Target must be within {base_dir}"
    except ValueError:
        # commonpath raises ValueError if paths are on different drives (Windows)
        return "", f"Invalid path. Target must be within {base_dir}"

    # Additional check: ensure full_path starts with base_dir
    # This handles edge cases like base="/workspace" and full="/workspaceevil"
    if not (full_path == base_dir or full_path.startswith(base_dir + os.sep)):
        return "", f"Path traversal detected. Target must be within {base_dir}"

    return full_path, None


def _run_git_command(
    args: list[str],
    cwd: Optional[str] = None,
    capture_output: bool = True,
) -> dict:
    """
    Run a git command and return the result.

    Args:
        args: Git command arguments (e.g., ["status", "--short"])
        cwd: Working directory for the command
        capture_output: Whether to capture stdout/stderr

    Returns:
        Dictionary with stdout, stderr, return_code
    """
    cmd = ["git"] + args
    try:
        result = subprocess.run(
            cmd,
            cwd=cwd or DEFAULT_WORKSPACE_DIR,
            capture_output=capture_output,
            text=True,
            timeout=300,  # 5 minute timeout for long operations like clone
        )
        return {
            "stdout": result.stdout,
            "stderr": result.stderr,
            "return_code": result.returncode,
            "success": result.returncode == 0,
        }
    except subprocess.TimeoutExpired:
        return {
            "stdout": "",
            "stderr": "Command timed out after 300 seconds",
            "return_code": -1,
            "success": False,
        }
    except Exception as e:
        return {
            "stdout": "",
            "stderr": str(e),
            "return_code": -1,
            "success": False,
        }


class GitCloneTool(Tool, ToolMarkerDoesNotRequireActiveProject):
    """Clone a GitHub repository to the workspace."""

    def apply(
        self,
        repo_url: str,
        branch: str = "main",
        target_dir: Optional[str] = None,
        depth: Optional[int] = None,
    ) -> str:
        """
        Clone a Git repository to the workspace.

        :param repo_url: The URL of the repository to clone (e.g., https://github.com/owner/repo.git)
        :param branch: The branch to checkout after cloning (default: main)
        :param target_dir: Optional subdirectory name within workspace (default: derived from repo URL)
        :param depth: Optional shallow clone depth (e.g., 1 for latest commit only)
        :return: JSON result with clone status and path
        """
        # Determine target directory
        if target_dir is None:
            # Extract repo name from URL
            repo_name = repo_url.rstrip("/").split("/")[-1]
            if repo_name.endswith(".git"):
                repo_name = repo_name[:-4]
            target_dir = repo_name

        # Sanitize and validate the target path to prevent path traversal attacks
        full_path, error = _sanitize_path(target_dir)
        if error:
            return json.dumps({
                "success": False,
                "error": error,
            })

        # Check if directory already exists
        if os.path.exists(full_path):
            return json.dumps({
                "success": False,
                "error": f"Directory already exists: {full_path}",
                "suggestion": "Use a different target_dir or delete the existing directory",
            })

        # Ensure workspace directory exists
        os.makedirs(DEFAULT_WORKSPACE_DIR, exist_ok=True)

        # Build clone command
        clone_args = ["clone", "--branch", branch]
        if depth is not None:
            clone_args.extend(["--depth", str(depth)])
        clone_args.extend([repo_url, full_path])

        result = _run_git_command(clone_args, cwd=DEFAULT_WORKSPACE_DIR)

        if result["success"]:
            # Also configure git user for commits (use generic values that can be overridden)
            _run_git_command(
                ["config", "user.email", "coding-agent@archestra.ai"],
                cwd=full_path,
            )
            _run_git_command(
                ["config", "user.name", "Archestra Coding Agent"],
                cwd=full_path,
            )

            return json.dumps({
                "success": True,
                "path": full_path,
                "branch": branch,
                "message": f"Successfully cloned {repo_url} to {full_path}",
            })
        else:
            return json.dumps({
                "success": False,
                "error": result["stderr"] or "Clone failed",
                "stdout": result["stdout"],
            })


class GitStatusTool(Tool, ToolMarkerDoesNotRequireActiveProject):
    """Get the current git status of a repository."""

    def apply(self, repo_path: Optional[str] = None) -> str:
        """
        Get the git status of a repository.

        :param repo_path: Path to the repository (default: first repo in workspace)
        :return: JSON result with git status information
        """
        path = repo_path or _get_default_repo_path()
        if path is None:
            return json.dumps({
                "success": False,
                "error": "No repository found. Clone a repository first.",
            })

        # Get short status
        status_result = _run_git_command(["status", "--short"], cwd=path)

        # Get branch name
        branch_result = _run_git_command(
            ["rev-parse", "--abbrev-ref", "HEAD"],
            cwd=path,
        )

        # Get remote tracking info
        remote_result = _run_git_command(
            ["status", "--branch", "--porcelain=v2"],
            cwd=path,
        )

        if status_result["success"]:
            files = []
            for line in status_result["stdout"].strip().split("\n"):
                if line:
                    status_code = line[:2]
                    filename = line[3:]
                    files.append({
                        "status": status_code.strip(),
                        "file": filename,
                    })

            return json.dumps({
                "success": True,
                "path": path,
                "branch": branch_result["stdout"].strip() if branch_result["success"] else "unknown",
                "files": files,
                "is_clean": len(files) == 0,
                "raw_status": status_result["stdout"],
            })
        else:
            return json.dumps({
                "success": False,
                "error": status_result["stderr"],
            })


class GitDiffTool(Tool, ToolMarkerDoesNotRequireActiveProject):
    """Show uncommitted changes in a repository."""

    def apply(
        self,
        repo_path: Optional[str] = None,
        staged: bool = False,
        file_path: Optional[str] = None,
    ) -> str:
        """
        Show the diff of uncommitted changes.

        :param repo_path: Path to the repository (default: first repo in workspace)
        :param staged: If True, show staged changes; if False, show unstaged changes
        :param file_path: Optional specific file to diff
        :return: JSON result with diff output
        """
        path = repo_path or _get_default_repo_path()
        if path is None:
            return json.dumps({
                "success": False,
                "error": "No repository found. Clone a repository first.",
            })

        diff_args = ["diff"]
        if staged:
            diff_args.append("--staged")
        if file_path:
            diff_args.extend(["--", file_path])

        result = _run_git_command(diff_args, cwd=path)

        if result["success"]:
            return json.dumps({
                "success": True,
                "path": path,
                "staged": staged,
                "diff": result["stdout"],
                "has_changes": len(result["stdout"].strip()) > 0,
            })
        else:
            return json.dumps({
                "success": False,
                "error": result["stderr"],
            })


class GitCommitTool(Tool, ToolMarkerDoesNotRequireActiveProject):
    """Stage all changes and commit them. Automatically runs 'git add' before committing - no separate git_add needed."""

    def apply(
        self,
        message: str,
        repo_path: Optional[str] = None,
        files: Optional[list[str]] = None,
        all_changes: bool = True,
    ) -> str:
        """
        Stage and commit changes. This tool automatically stages files before committing,
        so you don't need a separate git_add step.

        :param message: Commit message
        :param repo_path: Path to the repository (default: first repo in workspace)
        :param files: Optional list of specific files to stage and commit (if not provided, stages ALL changes)
        :param all_changes: If True and no files specified, stage all changes with 'git add -A' (default: True)
        :return: JSON result with commit information
        """
        path = repo_path or _get_default_repo_path()
        if path is None:
            return json.dumps({
                "success": False,
                "error": "No repository found. Clone a repository first.",
            })

        # Stage changes
        if files:
            # Stage specific files
            for file in files:
                add_result = _run_git_command(["add", file], cwd=path)
                if not add_result["success"]:
                    return json.dumps({
                        "success": False,
                        "error": f"Failed to stage {file}: {add_result['stderr']}",
                    })
        elif all_changes:
            # Stage all changes
            add_result = _run_git_command(["add", "-A"], cwd=path)
            if not add_result["success"]:
                return json.dumps({
                    "success": False,
                    "error": f"Failed to stage changes: {add_result['stderr']}",
                })

        # Commit
        commit_result = _run_git_command(["commit", "-m", message], cwd=path)

        if commit_result["success"]:
            # Get commit hash
            hash_result = _run_git_command(["rev-parse", "HEAD"], cwd=path)
            commit_hash = hash_result["stdout"].strip() if hash_result["success"] else "unknown"

            return json.dumps({
                "success": True,
                "path": path,
                "message": message,
                "commit_hash": commit_hash,
                "output": commit_result["stdout"],
            })
        else:
            # Check if nothing to commit
            if "nothing to commit" in commit_result["stdout"]:
                return json.dumps({
                    "success": False,
                    "error": "Nothing to commit - working tree is clean",
                })
            return json.dumps({
                "success": False,
                "error": commit_result["stderr"] or commit_result["stdout"],
            })


class GitPushTool(Tool, ToolMarkerDoesNotRequireActiveProject):
    """Push commits to the remote repository."""

    def apply(
        self,
        repo_path: Optional[str] = None,
        remote: str = "origin",
        branch: Optional[str] = None,
        set_upstream: bool = True,
        force: bool = False,
    ) -> str:
        """
        Push commits to the remote.

        :param repo_path: Path to the repository (default: first repo in workspace)
        :param remote: Remote name (default: origin)
        :param branch: Branch to push (default: current branch)
        :param set_upstream: Set upstream tracking (default: True)
        :param force: Force push (use with caution!)
        :return: JSON result with push information
        """
        path = repo_path or _get_default_repo_path()
        if path is None:
            return json.dumps({
                "success": False,
                "error": "No repository found. Clone a repository first.",
            })

        # Get current branch if not specified
        if branch is None:
            branch_result = _run_git_command(
                ["rev-parse", "--abbrev-ref", "HEAD"],
                cwd=path,
            )
            if branch_result["success"]:
                branch = branch_result["stdout"].strip()
            else:
                return json.dumps({
                    "success": False,
                    "error": "Could not determine current branch",
                })

        # Build push command
        push_args = ["push"]
        if set_upstream:
            push_args.extend(["-u"])
        if force:
            push_args.append("--force")
        push_args.extend([remote, branch])

        result = _run_git_command(push_args, cwd=path)

        if result["success"]:
            return json.dumps({
                "success": True,
                "path": path,
                "remote": remote,
                "branch": branch,
                "message": f"Successfully pushed to {remote}/{branch}",
                "output": result["stderr"],  # git push outputs to stderr
            })
        else:
            return json.dumps({
                "success": False,
                "error": result["stderr"] or result["stdout"],
            })


class GitCheckoutBranchTool(Tool, ToolMarkerDoesNotRequireActiveProject):
    """Create or switch to a branch."""

    def apply(
        self,
        branch_name: str,
        repo_path: Optional[str] = None,
        create: bool = True,
        start_point: Optional[str] = None,
    ) -> str:
        """
        Create a new branch or switch to an existing branch.

        :param branch_name: Name of the branch
        :param repo_path: Path to the repository (default: first repo in workspace)
        :param create: If True, create the branch if it doesn't exist (default: True)
        :param start_point: Optional commit/branch to start from when creating
        :return: JSON result with branch operation status
        """
        path = repo_path or _get_default_repo_path()
        if path is None:
            return json.dumps({
                "success": False,
                "error": "No repository found. Clone a repository first.",
            })

        # Check if branch exists
        check_result = _run_git_command(
            ["rev-parse", "--verify", f"refs/heads/{branch_name}"],
            cwd=path,
        )
        branch_exists = check_result["success"]

        if branch_exists:
            # Switch to existing branch
            result = _run_git_command(["checkout", branch_name], cwd=path)
            action = "switched to"
        elif create:
            # Create and switch to new branch
            checkout_args = ["checkout", "-b", branch_name]
            if start_point:
                checkout_args.append(start_point)
            result = _run_git_command(checkout_args, cwd=path)
            action = "created and switched to"
        else:
            return json.dumps({
                "success": False,
                "error": f"Branch '{branch_name}' does not exist. Set create=True to create it.",
            })

        if result["success"]:
            return json.dumps({
                "success": True,
                "path": path,
                "branch": branch_name,
                "action": action,
                "message": f"Successfully {action} branch '{branch_name}'",
            })
        else:
            return json.dumps({
                "success": False,
                "error": result["stderr"] or result["stdout"],
            })


def _get_default_repo_path() -> Optional[str]:
    """
    Get the path to the first repository in the workspace.

    Returns:
        Path to the first git repository found, or None if no repos exist
    """
    if not os.path.exists(DEFAULT_WORKSPACE_DIR):
        return None

    for entry in os.listdir(DEFAULT_WORKSPACE_DIR):
        entry_path = os.path.join(DEFAULT_WORKSPACE_DIR, entry)
        if os.path.isdir(entry_path):
            git_dir = os.path.join(entry_path, ".git")
            if os.path.exists(git_dir):
                return entry_path

    return None

