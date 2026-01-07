"""
Tests for the GitHub tools.

These tests mock the PyGithub library to avoid actual API calls.
"""

import json
import os
import pytest
from unittest.mock import patch, MagicMock
from datetime import datetime

# Mock serena.tools before importing our tools
import sys
sys.modules['serena'] = MagicMock()
sys.modules['serena.tools'] = MagicMock()
sys.modules['serena.tools'].Tool = object

# Mock github module
mock_github = MagicMock()
mock_github.GithubException = Exception
sys.modules['github'] = mock_github

# Now import our tools
from src.tools.github_tools import (
    GitHubCreatePRTool,
    GitHubListPRsTool,
    GitHubGetIssueTool,
    _parse_repo_info,
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

    def test_parse_owner_repo_format(self):
        """Test parsing owner/repo format."""
        owner, repo = _parse_repo_info("owner/repo")
        assert owner == "owner"
        assert repo == "repo"

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


class TestGitHubCreatePRTool:
    """Tests for the GitHubCreatePRTool."""

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

        tool = GitHubCreatePRTool()
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

        tool = GitHubCreatePRTool()
        result = json.loads(tool.apply(
            title="Test PR",
            body="PR description",
            head="feature/test",
            repo="owner/repo",
        ))

        assert result["success"] is False
        assert "GITHUB_TOKEN" in result["error"]


class TestGitHubListPRsTool:
    """Tests for the GitHubListPRsTool."""

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

        tool = GitHubListPRsTool()
        result = json.loads(tool.apply(repo="owner/repo"))

        assert result["success"] is True
        assert result["count"] == 1
        assert result["pull_requests"][0]["number"] == 1


class TestGitHubGetIssueTool:
    """Tests for the GitHubGetIssueTool."""

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

        tool = GitHubGetIssueTool()
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

