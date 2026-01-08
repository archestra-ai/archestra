"""
Tests for the Git tools.

These tests mock subprocess calls to avoid actual git operations.
"""

import json
import os
import pytest
from unittest.mock import patch, MagicMock

# Mock serena modules before importing our tools
import sys

# Create base classes for mocking - Tool must be a proper base class
class MockTool:
    """Mock base class for Serena Tool."""
    pass

class MockToolMarkerDoesNotRequireActiveProject:
    """Mock marker class."""
    pass

mock_tools = MagicMock()
mock_tools.Tool = MockTool

mock_tools_base = MagicMock()
mock_tools_base.ToolMarkerDoesNotRequireActiveProject = MockToolMarkerDoesNotRequireActiveProject

sys.modules['serena'] = MagicMock()
sys.modules['serena.tools'] = mock_tools
sys.modules['serena.tools.tools_base'] = mock_tools_base

# Now import our tools
from src.tools.git_tools import (
    GitCloneTool,
    GitStatusTool,
    GitDiffTool,
    GitCommitTool,
    GitPushTool,
    GitCheckoutBranchTool,
    _run_git_command,
    _get_default_repo_path,
    _sanitize_path,
    DEFAULT_WORKSPACE_DIR,
)


class TestSanitizePath:
    """Tests for the _sanitize_path helper function - path traversal prevention."""

    def test_valid_simple_directory(self):
        """Test valid simple directory name."""
        path, error = _sanitize_path("my-repo", "/workspace")
        assert error is None
        assert path == "/workspace/my-repo"

    def test_valid_nested_directory(self):
        """Test valid nested directory path."""
        path, error = _sanitize_path("org/repo", "/workspace")
        assert error is None
        assert path == "/workspace/org/repo"

    def test_reject_absolute_path(self):
        """Test that absolute paths are rejected."""
        path, error = _sanitize_path("/tmp/evil", "/workspace")
        assert error is not None
        assert "Absolute paths are not allowed" in error
        assert path == ""

    def test_reject_absolute_path_etc(self):
        """Test that absolute paths to sensitive locations are rejected."""
        path, error = _sanitize_path("/etc/passwd", "/workspace")
        assert error is not None
        assert "Absolute paths are not allowed" in error

    def test_reject_parent_traversal(self):
        """Test that ../ traversal is rejected."""
        path, error = _sanitize_path("../escape", "/workspace")
        assert error is not None
        assert "Path traversal detected" in error

    def test_reject_deep_parent_traversal(self):
        """Test that deep ../ traversal is rejected."""
        path, error = _sanitize_path("../../etc/passwd", "/workspace")
        assert error is not None
        assert "Path traversal detected" in error

    def test_reject_hidden_traversal(self):
        """Test that hidden traversal (foo/../..) is rejected."""
        path, error = _sanitize_path("foo/../../etc", "/workspace")
        assert error is not None
        assert "Path traversal detected" in error

    def test_reject_workspace_prefix_attack(self):
        """Test that /workspaceevil doesn't match /workspace."""
        # This tests the edge case where commonpath might be fooled
        path, error = _sanitize_path("../workspaceevil", "/workspace")
        assert error is not None
        assert "Path traversal detected" in error

    def test_valid_path_with_dots_in_name(self):
        """Test that dots in directory names are allowed."""
        path, error = _sanitize_path("my.repo.name", "/workspace")
        assert error is None
        assert path == "/workspace/my.repo.name"

    def test_valid_path_with_current_dir(self):
        """Test that ./ is normalized correctly."""
        path, error = _sanitize_path("./my-repo", "/workspace")
        assert error is None
        assert path == "/workspace/my-repo"


class TestRunGitCommand:
    """Tests for the _run_git_command helper function."""

    @patch('subprocess.run')
    def test_successful_command(self, mock_run):
        """Test successful git command execution."""
        mock_run.return_value = MagicMock(
            stdout="output",
            stderr="",
            returncode=0,
        )

        result = _run_git_command(["status"])

        assert result["success"] is True
        assert result["stdout"] == "output"
        assert result["return_code"] == 0
        mock_run.assert_called_once()

    @patch('subprocess.run')
    def test_failed_command(self, mock_run):
        """Test failed git command execution."""
        mock_run.return_value = MagicMock(
            stdout="",
            stderr="error message",
            returncode=1,
        )

        result = _run_git_command(["invalid-command"])

        assert result["success"] is False
        assert result["stderr"] == "error message"
        assert result["return_code"] == 1


class TestGitCloneTool:
    """Tests for the GitCloneTool."""

    @patch('src.tools.git_tools._run_git_command')
    @patch('os.path.exists')
    @patch('os.makedirs')
    def test_clone_success(self, mock_makedirs, mock_exists, mock_git):
        """Test successful repository clone."""
        mock_exists.return_value = False
        mock_git.return_value = {"success": True, "stdout": "", "stderr": ""}

        tool = GitCloneTool()
        result = json.loads(tool.apply(
            repo_url="https://github.com/owner/repo.git",
            branch="main",
        ))

        assert result["success"] is True
        assert "repo" in result["path"]

    @patch('os.path.exists')
    def test_clone_directory_exists(self, mock_exists):
        """Test clone fails when directory already exists."""
        mock_exists.return_value = True

        tool = GitCloneTool()
        result = json.loads(tool.apply(
            repo_url="https://github.com/owner/repo.git",
        ))

        assert result["success"] is False
        assert "already exists" in result["error"]

    def test_clone_rejects_absolute_path(self):
        """Test clone rejects absolute target_dir paths."""
        tool = GitCloneTool()
        result = json.loads(tool.apply(
            repo_url="https://github.com/owner/repo.git",
            target_dir="/tmp/evil",
        ))

        assert result["success"] is False
        assert "Absolute paths are not allowed" in result["error"]

    def test_clone_rejects_path_traversal(self):
        """Test clone rejects path traversal attempts."""
        tool = GitCloneTool()
        result = json.loads(tool.apply(
            repo_url="https://github.com/owner/repo.git",
            target_dir="../escape",
        ))

        assert result["success"] is False
        assert "Path traversal detected" in result["error"]

    def test_clone_rejects_deep_path_traversal(self):
        """Test clone rejects deep path traversal attempts."""
        tool = GitCloneTool()
        result = json.loads(tool.apply(
            repo_url="https://github.com/owner/repo.git",
            target_dir="../../etc/passwd",
        ))

        assert result["success"] is False
        assert "Path traversal detected" in result["error"]


class TestGitStatusTool:
    """Tests for the GitStatusTool."""

    @patch('src.tools.git_tools._get_default_repo_path')
    @patch('src.tools.git_tools._run_git_command')
    def test_status_clean_repo(self, mock_git, mock_path):
        """Test status on a clean repository."""
        mock_path.return_value = "/workspace/repo"
        mock_git.side_effect = [
            {"success": True, "stdout": "", "stderr": ""},  # status --short
            {"success": True, "stdout": "main\n", "stderr": ""},  # branch
            {"success": True, "stdout": "", "stderr": ""},  # status --porcelain
        ]

        tool = GitStatusTool()
        result = json.loads(tool.apply())

        assert result["success"] is True
        assert result["is_clean"] is True
        assert result["branch"] == "main"

    @patch('src.tools.git_tools._get_default_repo_path')
    def test_status_no_repo(self, mock_path):
        """Test status when no repository exists."""
        mock_path.return_value = None

        tool = GitStatusTool()
        result = json.loads(tool.apply())

        assert result["success"] is False
        assert "No repository found" in result["error"]


class TestGitCommitTool:
    """Tests for the GitCommitTool."""

    @patch('src.tools.git_tools._get_default_repo_path')
    @patch('src.tools.git_tools._run_git_command')
    def test_commit_success(self, mock_git, mock_path):
        """Test successful commit."""
        mock_path.return_value = "/workspace/repo"
        mock_git.side_effect = [
            {"success": True, "stdout": "", "stderr": ""},  # add -A
            {"success": True, "stdout": "committed", "stderr": ""},  # commit
            {"success": True, "stdout": "abc123\n", "stderr": ""},  # rev-parse
        ]

        tool = GitCommitTool()
        result = json.loads(tool.apply(message="Test commit"))

        assert result["success"] is True
        assert result["commit_hash"] == "abc123"

    @patch('src.tools.git_tools._get_default_repo_path')
    @patch('src.tools.git_tools._run_git_command')
    def test_commit_nothing_to_commit(self, mock_git, mock_path):
        """Test commit when nothing to commit."""
        mock_path.return_value = "/workspace/repo"
        mock_git.side_effect = [
            {"success": True, "stdout": "", "stderr": ""},  # add -A
            {"success": False, "stdout": "nothing to commit", "stderr": ""},  # commit
        ]

        tool = GitCommitTool()
        result = json.loads(tool.apply(message="Test commit"))

        assert result["success"] is False
        assert "nothing to commit" in result["error"].lower()


class TestGitPushTool:
    """Tests for the GitPushTool."""

    @patch('src.tools.git_tools._get_default_repo_path')
    @patch('src.tools.git_tools._run_git_command')
    def test_push_success(self, mock_git, mock_path):
        """Test successful push."""
        mock_path.return_value = "/workspace/repo"
        mock_git.side_effect = [
            {"success": True, "stdout": "main\n", "stderr": ""},  # rev-parse branch
            {"success": True, "stdout": "", "stderr": "pushed"},  # push
        ]

        tool = GitPushTool()
        result = json.loads(tool.apply())

        assert result["success"] is True
        assert result["branch"] == "main"


class TestGitCheckoutBranchTool:
    """Tests for the GitCheckoutBranchTool."""

    @patch('src.tools.git_tools._get_default_repo_path')
    @patch('src.tools.git_tools._run_git_command')
    def test_create_new_branch(self, mock_git, mock_path):
        """Test creating a new branch."""
        mock_path.return_value = "/workspace/repo"
        mock_git.side_effect = [
            {"success": False, "stdout": "", "stderr": ""},  # branch doesn't exist
            {"success": True, "stdout": "", "stderr": ""},  # checkout -b
        ]

        tool = GitCheckoutBranchTool()
        result = json.loads(tool.apply(branch_name="feature/test"))

        assert result["success"] is True
        assert "created" in result["action"]

    @patch('src.tools.git_tools._get_default_repo_path')
    @patch('src.tools.git_tools._run_git_command')
    def test_switch_existing_branch(self, mock_git, mock_path):
        """Test switching to an existing branch."""
        mock_path.return_value = "/workspace/repo"
        mock_git.side_effect = [
            {"success": True, "stdout": "", "stderr": ""},  # branch exists
            {"success": True, "stdout": "", "stderr": ""},  # checkout
        ]

        tool = GitCheckoutBranchTool()
        result = json.loads(tool.apply(branch_name="main"))

        assert result["success"] is True
        assert "switched to" in result["action"]


if __name__ == "__main__":
    pytest.main([__file__, "-v"])

