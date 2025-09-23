import { useLocation, useNavigate } from '@tanstack/react-router';
import { Bug, Plus, SidebarIcon } from 'lucide-react';
import { useEffect, useState } from 'react';

import BugReportDialog from '@ui/components/BackendLogsDialog';
import { ThemeToggler } from '@ui/components/ThemeToggler';
import { Button } from '@ui/components/ui/button';
import { useSidebar } from '@ui/components/ui/sidebar';
import { useChatStore } from '@ui/stores';

import { Breadcrumbs } from './Breadcrumbs';

export function SiteHeader() {
  const { toggleSidebar } = useSidebar();
  const { getCurrentChatTitle, createNewChat } = useChatStore();
  const navigate = useNavigate();
  const location = useLocation();
  const [showLogsDialog, setShowLogsDialog] = useState(false);
  const [appInfo, setAppInfo] = useState<{
    version: string;
    isPackaged: boolean;
  } | null>(null);
  const [systemInfo, setSystemInfo] = useState<{
    platform: string;
    arch: string;
    osVersion: string;
    nodeVersion: string;
    electronVersion: string;
    cpu: string;
    totalMemory: string;
    freeMemory: string;
    totalDisk: string;
    freeDisk: string;
  } | null>(null);

  useEffect(() => {
    if (window.electronAPI?.getAppInfo) {
      window.electronAPI.getAppInfo().then(setAppInfo);
    }
    if (window.electronAPI?.getSystemInfo) {
      window.electronAPI.getSystemInfo().then(setSystemInfo);
    }
  }, []);

  let breadcrumbs: string[] = [];
  const path = location.pathname;

  if (path.startsWith('/chat')) {
    breadcrumbs = ['Agents', getCurrentChatTitle()];
  } else if (path === '/llm-providers/ollama') {
    breadcrumbs = ['Local models'];
  } else if (path === '/llm-providers/cloud') {
    breadcrumbs = ['Cloud models'];
  } else if (path.startsWith('/connectors')) {
    breadcrumbs = ['MCP Connectors'];
  } else if (path === '/settings/mcp-clients') {
    breadcrumbs = ['Use as MCP Proxy'];
  }

  const appVersion = appInfo?.version;
  const appPackaged = appInfo?.isPackaged;

  const handleReportBug = () => {
    const issueBody = encodeURIComponent(
      `
**Description:**
Please describe the issue you're experiencing...

**Steps to Reproduce:**
1. 
2. 
3. 

**Expected Behavior:**
What did you expect to happen?

**Actual Behavior:**
What actually happened?

**Relevant logs**

\`\`\`
Put relevant logs here (if any)
\`\`\`

**System Information:**
- **App Version:** ${appVersion}
- **App Packaged:** ${appPackaged ? 'Yes' : 'No'}
- **Platform:** ${systemInfo?.platform || 'Unknown'}
- **Architecture:** ${systemInfo?.arch || 'Unknown'}
- **OS Version:** ${systemInfo?.osVersion || 'Unknown'}
- **Node Version:** ${systemInfo?.nodeVersion || 'Unknown'}
- **Electron Version:** ${systemInfo?.electronVersion || 'Unknown'}

**Machine Specs:**
- **CPU:** ${systemInfo?.cpu || 'Unknown'}
- **Total Memory:** ${systemInfo?.totalMemory || 'Unknown'}
- **Free Memory:** ${systemInfo?.freeMemory || 'Unknown'}
- **Total Disk:** ${systemInfo?.totalDisk || 'Unknown'}
- **Free Disk:** ${systemInfo?.freeDisk || 'Unknown'}
    `.trim()
    );

    const issueTitle = encodeURIComponent('[Put the bug title here] ');
    const url = `https://github.com/archestra-ai/archestra/issues/new?title=${issueTitle}&body=${issueBody}`;
    if (window.electronAPI?.openExternal) {
      window.electronAPI.openExternal(url);
    } else {
      window.open(url, '_blank');
    }
  };

  const handleGHStar = () => {
    const url = `https://github.com/archestra-ai/archestra`;
    if (window.electronAPI?.openExternal) {
      window.electronAPI.openExternal(url);
    } else {
      window.open(url, '_blank');
    }
  };

  /**
   * For more context on WebKitAppRegion see https://github.com/electron/electron/issues/1354
   *
   * Basically we set the whole SiteHeader to be draggable, and then the particular sub-sections that we
   * want to be non-draggable we set the WebkitAppRegion to 'no-drag' (for things like buttons so that
   * the click events are not blocked by the draggable region)
   */
  return (
    <header
      className="bg-background sticky top-0 z-50 flex w-full items-center border-b"
      // @ts-expect-error - WebkitAppRegion is not a valid property
      style={{ WebkitAppRegion: 'drag' }}
    >
      <div className="flex h-[var(--header-height)] w-64 items-center gap-2 px-4 pl-20 border-r shrink-0">
        <Button
          className="h-8 w-8 cursor-pointer"
          variant="ghost"
          size="icon"
          onClick={toggleSidebar}
          // @ts-expect-error - WebkitAppRegion is not a valid property
          style={{ WebkitAppRegion: 'no-drag' }}
        >
          <SidebarIcon />
        </Button>

        <Button
          className="hidden sm:flex cursor-pointer"
          variant="ghost"
          size="sm"
          onClick={async () => {
            await createNewChat();
            navigate({ to: '/chat' });
          }}
          // @ts-expect-error - WebkitAppRegion is not a valid property
          style={{ WebkitAppRegion: 'no-drag' }}
        >
          <Plus className="h-4 w-4 mr-1" />
          <span className="hidden lg:inline">New Agent</span>
        </Button>
      </div>
      <div className="flex h-[var(--header-height)] flex-1 items-center justify-between px-2 sm:px-4 min-w-0 overflow-hidden">
        <div className="min-w-0 flex-1 truncate flex items-center h-full">
          <Breadcrumbs breadcrumbs={breadcrumbs} isAnimatedTitle={path.startsWith('/chat')} />
        </div>
        {/* @ts-expect-error - WebkitAppRegion is not a valid property */}
        <div className="flex items-center gap-1 sm:gap-2 shrink-0 border-l pl-4" style={{ WebkitAppRegion: 'no-drag' }}>
          <span className="text-xs text-muted-foreground hidden lg:inline">This is v{appVersion},</span>
          <span className="text-xs text-muted-foreground hidden sm:inline lg:hidden">v{appVersion}</span>
          <Button
            className="h-6 text-xs px-2 sm:px-3 bg-gray-500 hover:bg-gray-600 text-white"
            size="sm"
            onClick={() => setShowLogsDialog(true)}
            title="Report a bug"
          >
            <span className="hidden sm:inline">Report a</span>
            <Bug className="h-3.5 w-3.5 sm:ml-1" />
          </Button>
          <span className="text-xs text-muted-foreground hidden sm:inline">or</span>
          <Button
            className="h-6 text-xs px-2 sm:px-3 bg-gray-500 hover:bg-gray-600 text-white"
            size="sm"
            onClick={handleGHStar}
            title="Star us on GitHub"
          >
            <span className="hidden sm:inline">give us a</span>
            <span className="sm:ml-1">⭐️</span>
          </Button>
          <ThemeToggler />
        </div>
      </div>
      <BugReportDialog
        open={showLogsDialog}
        onOpenChange={setShowLogsDialog}
        onReportBug={handleReportBug}
        appVersion={appVersion}
        systemInfo={systemInfo}
      />
    </header>
  );
}
