import { GitGraph } from 'lucide-react';

import { Button } from '@ui/components/ui/button';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@ui/components/ui/hover-card';

interface ReportIssueWithCatalogEntryProps {
  catalogId: string;
}

export default function ReportIssueWithCatalogEntry({ catalogId }: ReportIssueWithCatalogEntryProps) {
  // Check if this is a catalog entry (not a UUID for custom servers)
  const isCatalogEntry = !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(catalogId);

  // Don't render anything if it's not a catalog entry
  if (!isCatalogEntry) {
    return null;
  }

  const handleReportIssue = async () => {
    const issueTitle = `[MCP Catalog] Issue with ${catalogId}`;
    const encodedTitle = encodeURIComponent(issueTitle);

    try {
      // Check if there's an existing open issue
      const searchQuery = encodeURIComponent(
        `is:issue "${issueTitle}" in:title repo:archestra-ai/archestra state:open`
      );
      const response = await fetch(`https://api.github.com/search/issues?q=${searchQuery}`);

      if (response.ok) {
        const data = await response.json();

        if (data.total_count > 0 && data.items?.[0]?.html_url) {
          // Open existing issue
          window.electronAPI.openExternal(data.items[0].html_url);
        } else {
          // Open new issue with template
          const newIssueUrl = `https://github.com/archestra-ai/archestra/issues/new?template=mcp-catalog-entry-issue.md&title=${encodedTitle}`;
          window.electronAPI.openExternal(newIssueUrl);
        }
      } else {
        // If API call fails, default to creating new issue
        const newIssueUrl = `https://github.com/archestra-ai/archestra/issues/new?template=mcp-catalog-entry-issue.md&title=${encodedTitle}`;
        window.electronAPI.openExternal(newIssueUrl);
      }
    } catch (error) {
      // If there's any error, default to creating new issue
      const newIssueUrl = `https://github.com/archestra-ai/archestra/issues/new?template=mcp-catalog-entry-issue.md&title=${encodedTitle}`;
      window.electronAPI.openExternal(newIssueUrl);
    }
  };

  return (
    <HoverCard openDelay={100} closeDelay={0}>
      <HoverCardTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 cursor-pointer"
          onClick={handleReportIssue}
          title="Report issue"
        >
          <GitGraph className="h-3 w-3" />
        </Button>
      </HoverCardTrigger>
      <HoverCardContent side="left" className="w-64">
        <div className="text-sm">Report issue with catalog entry on GitHub</div>
      </HoverCardContent>
    </HoverCard>
  );
}
