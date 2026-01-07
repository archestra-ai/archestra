"""
Tests for the GitHub tools.

These tests mock the PyGithub library to avoid actual API calls.
"""

import json
import os
import pytest
from unittest.mock import patch, MagicMock
from datetime import datetime

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

# Mock github module with a proper exception class
class MockGithubException(Exception):
    def __init__(self, status, data=None):
        super().__init__(f"GithubException: {status}")
        self.status = status
        self.data = data

mock_github = MagicMock()
mock_github.GithubException = MockGithubException
sys.modules['github'] = mock_github

# Now import our tools
from src.tools.github_tools import (
    GithubCreatePrTool,
    GithubListPrsTool,
    GithubGetIssueTool,
    _parse_repo_info,
    _get_github_error_message,
)


class TestParseRepoInfo:
    """Tests for the _parse_repo_info helper function."""

    def test_parse_full_url(self):
        """Test parsing full GitHub URL."""
        owner, repo = _parse_repo_info("https://github.com/owner/repo")
        assert owner == "owner"
        assert repo == "repo"

    def test_parse_url_with_git_suffix(self):
        """Test parsing URL with .git suffix."""
        owner, repo = _parse_repo_info("https://github.com/owner/repo.git")
        assert owner == "owner"
        assert repo == "repo"

    def test_parse_url_with_trailing_slash(self):
        """Test parsing URL with trailing slash."""
        owner, repo = _parse_repo_info("https://github.com/owner/repo/")
        assert owner == "owner"
        assert repo == "repo"

    def test_parse_url_without_https(self):
        """Test parsing URL without https prefix."""
        owner, repo = _parse_repo_info("github.com/owner/repo")
        assert owner == "owner"
        assert repo == "repo"

    def test_parse_url_with_www(self):
        """Test parsing URL with www prefix."""
        owner, repo = _parse_repo_info("https://www.github.com/owner/repo")
        assert owner == "owner"
        assert repo == "repo"

    def test_parse_ssh_url(self):
        """Test parsing SSH URL format."""
        owner, repo = _parse_repo_info("git@github.com:owner/repo")
        assert owner == "owner"
        assert repo == "repo"

    def test_parse_ssh_url_with_git_suffix(self):
        """Test parsing SSH URL with .git suffix."""
        owner, repo = _parse_repo_info("git@github.com:owner/repo.git")
        assert owner == "owner"
        assert repo == "repo"

    def test_parse_owner_repo_format(self):
        """Test parsing owner/repo format."""
        owner, repo = _parse_repo_info("owner/repo")
        assert owner == "owner"
        assert repo == "repo"

    def test_parse_owner_repo_with_special_chars(self):
        """Test parsing owner/repo with allowed special characters."""
        owner, repo = _parse_repo_info("my-org/my_repo.test")
        assert owner == "my-org"
        assert repo == "my_repo.test"

    def test_parse_invalid_format(self):
        """Test parsing invalid format."""
        owner, repo = _parse_repo_info("invalid")
        assert owner is None
        assert repo is None

    def test_parse_none(self):
        """Test parsing None."""
        owner, repo = _parse_repo_info(None)
        assert owner is None
        assert repo is None

    def test_parse_with_whitespace(self):
        """Test parsing with leading/trailing whitespace."""
        owner, repo = _parse_repo_info("  owner/repo  ")
        assert owner == "owner"
        assert repo == "repo"

    # Security tests - URL injection prevention
    def test_reject_malicious_url_with_github_in_path(self):
        """Test that URLs with github.com in path (not host) are rejected."""
        owner, repo = _parse_repo_info("https://evil.com/github.com/malicious/repo")
        assert owner is None
        assert repo is None

    def test_reject_malicious_url_with_subdomain(self):
        """Test that URLs with github.com as subdomain are rejected."""
        owner, repo = _parse_repo_info("https://github.com.evil.com/owner/repo")
        assert owner is None
        assert repo is None

    def test_reject_malicious_url_with_github_in_query(self):
        """Test that URLs with github.com in query string are rejected."""
        owner, repo = _parse_repo_info("https://evil.com/path?redirect=github.com/owner/repo")
        assert owner is None
        assert repo is None

    def test_reject_malicious_url_with_at_sign(self):
        """Test that URLs with @ credential injection are rejected."""
        owner, repo = _parse_repo_info("https://github.com@evil.com/owner/repo")
        assert owner is None
        assert repo is None

    def test_reject_too_many_path_segments(self):
        """Test that URLs with extra path segments are rejected."""
        owner, repo = _parse_repo_info("owner/repo/extra/path")
        assert owner is None
        assert repo is None


class TestGetGithubErrorMessage:
    """Tests for the _get_github_error_message helper function."""

    def test_error_with_dict_data(self):
        """Test error message extraction when data is a dict."""
        exc = MockGithubException(404, {"message": "Not Found"})
        assert _get_github_error_message(exc) == "Not Found"

    def test_error_with_dict_data_no_message(self):
        """Test error message extraction when dict has no message key."""
        exc = MockGithubException(500, {"error": "Internal Server Error"})
        # Should fall back to str(e)
        message = _get_github_error_message(exc)
        assert "500" in message or "GithubException" in message

    def test_error_with_none_data(self):
        """Test error message extraction when data is None."""
        exc = MockGithubException(401, None)
        message = _get_github_error_message(exc)
        # Should return str(e) when data is None
        assert message is not None
        assert len(message) > 0

    def test_error_with_string_data(self):
        """Test error message extraction when data is a string."""
        exc = MockGithubException(400, "Bad Request")
        message = _get_github_error_message(exc)
        assert message == "Bad Request"

    def test_error_with_empty_string_data(self):
        """Test error message extraction when data is empty string."""
        exc = MockGithubException(400, "")
        message = _get_github_error_message(exc)
        # Empty string is falsy, should fall back to str(e)
        assert message is not None
        assert len(message) > 0


class TestGithubCreatePrTool:
    """Tests for the GithubCreatePrTool."""

    @patch('src.tools.github_tools._get_github_client')
    @patch('src.tools.github_tools.GITHUB_AVAILABLE', True)
    def test_create_pr_success(self, mock_client):
        """Test successful PR creation."""
        # Set up mocks
        mock_pr = MagicMock()
        mock_pr.number = 42
        mock_pr.html_url = "https://github.com/owner/repo/pull/42"
        mock_pr.title = "Test PR"
        mock_pr.state = "open"

        mock_repo = MagicMock()
        mock_repo.create_pull.return_value = mock_pr

        mock_gh = MagicMock()
        mock_gh.get_repo.return_value = mock_repo
        mock_client.return_value = mock_gh

        tool = GithubCreatePrTool()
        result = json.loads(tool.apply(
            title="Test PR",
            body="PR description",
            head="feature/test",
            base="main",
            repo="owner/repo",
        ))

        assert result["success"] is True
        assert result["pr_number"] == 42
        assert result["pr_url"] == "https://github.com/owner/repo/pull/42"

    @patch('src.tools.github_tools._get_github_client')
    @patch('src.tools.github_tools.GITHUB_AVAILABLE', True)
    def test_create_pr_no_token(self, mock_client):
        """Test PR creation without token."""
        mock_client.return_value = None

        tool = GithubCreatePrTool()
        result = json.loads(tool.apply(
            title="Test PR",
            body="PR description",
            head="feature/test",
            repo="owner/repo",
        ))

        assert result["success"] is False
        assert "GITHUB_TOKEN" in result["error"]


class TestGithubListPrsTool:
    """Tests for the GithubListPrsTool."""

    @patch('src.tools.github_tools._get_github_client')
    @patch('src.tools.github_tools.GITHUB_AVAILABLE', True)
    def test_list_prs_success(self, mock_client):
        """Test successful PR listing."""
        # Set up mocks
        mock_pr = MagicMock()
        mock_pr.number = 1
        mock_pr.title = "Test PR"
        mock_pr.state = "open"
        mock_pr.html_url = "https://github.com/owner/repo/pull/1"
        mock_pr.user.login = "testuser"
        mock_pr.head.ref = "feature/test"
        mock_pr.base.ref = "main"
        mock_pr.created_at = datetime(2024, 1, 1)
        mock_pr.updated_at = datetime(2024, 1, 2)
        mock_pr.draft = False

        mock_repo = MagicMock()
        mock_repo.get_pulls.return_value = [mock_pr]

        mock_gh = MagicMock()
        mock_gh.get_repo.return_value = mock_repo
        mock_client.return_value = mock_gh

        tool = GithubListPrsTool()
        result = json.loads(tool.apply(repo="owner/repo"))

        assert result["success"] is True
        assert result["count"] == 1
        assert result["pull_requests"][0]["number"] == 1


class TestGithubGetIssueTool:
    """Tests for the GithubGetIssueTool."""

    @patch('src.tools.github_tools._get_github_client')
    @patch('src.tools.github_tools.GITHUB_AVAILABLE', True)
    def test_get_issue_success(self, mock_client):
        """Test successful issue retrieval."""
        # Set up mocks
        mock_label = MagicMock()
        mock_label.name = "bug"

        mock_issue = MagicMock()
        mock_issue.number = 123
        mock_issue.title = "Test Issue"
        mock_issue.state = "open"
        mock_issue.html_url = "https://github.com/owner/repo/issues/123"
        mock_issue.body = "Issue description"
        mock_issue.user.login = "testuser"
        mock_issue.labels = [mock_label]
        mock_issue.assignees = []
        mock_issue.created_at = datetime(2024, 1, 1)
        mock_issue.updated_at = datetime(2024, 1, 2)
        mock_issue.closed_at = None
        mock_issue.comments = 0

        mock_repo = MagicMock()
        mock_repo.get_issue.return_value = mock_issue

        mock_gh = MagicMock()
        mock_gh.get_repo.return_value = mock_repo
        mock_client.return_value = mock_gh

        tool = GithubGetIssueTool()
        result = json.loads(tool.apply(
            repo="owner/repo",
            issue_number=123,
        ))

        assert result["success"] is True
        assert result["number"] == 123
        assert result["title"] == "Test Issue"
        assert "bug" in result["labels"]


if __name__ == "__main__":
    pytest.main([__file__, "-v"])

