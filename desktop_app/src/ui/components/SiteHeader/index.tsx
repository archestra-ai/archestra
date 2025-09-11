import { useLocation, useNavigate } from '@tanstack/react-router';
import { Bug, Plus, SidebarIcon } from 'lucide-react';
import { useEffect, useState } from 'react';

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
    window.electronAPI.getAppInfo().then(setAppInfo);
    window.electronAPI.getSystemInfo().then(setSystemInfo);
  }, []);

  let breadcrumbs: string[] = [];
  const path = location.pathname;

  if (path.startsWith('/chat')) {
    breadcrumbs = ['Chat', getCurrentChatTitle()];
  } else if (path.startsWith('/llm-providers')) {
    breadcrumbs = ['LLM Providers'];
    if (path.includes('/ollama')) {
      breadcrumbs.push('Ollama');
    } else if (path.includes('/cloud')) {
      breadcrumbs.push('Cloud');
    }
  } else if (path.startsWith('/connectors')) {
    breadcrumbs = ['Connectors'];
  } else if (path.startsWith('/settings')) {
    breadcrumbs = ['Settings'];
    if (path.includes('/mcp-servers')) {
      breadcrumbs.push('Servers');
    } else if (path.includes('/mcp-clients')) {
      breadcrumbs.push('Clients');
    } else if (path.includes('/ollama')) {
      breadcrumbs.push('Ollama');
    }
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

    const issueTitle = encodeURIComponent('[Put the Bug title here] ');
    const url = `https://github.com/archestra-ai/archestra/issues/new?title=${issueTitle}&body=${issueBody}`;
    window.electronAPI.openExternal(url);
  };

  const handleGHStar = () => {
    const url = `https://github.com/archestra-ai/archestra`;
    window.electronAPI.openExternal(url);
  };

  return (
    <header className="bg-background sticky top-0 z-50 flex w-full items-center border-b">
      <div
        className="flex h-[var(--header-height)] w-64 items-center gap-2 px-4 pl-20 border-r shrink-0"
        // @ts-expect-error - WebkitAppRegion is not a valid property
        style={{ WebkitAppRegion: 'drag' }}
      >
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
          className="h-8 cursor-pointer hidden sm:flex"
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
          <span className="hidden lg:inline">New Chat</span>
        </Button>
      </div>
      <div
        className="flex h-[var(--header-height)] flex-1 items-center justify-between px-2 sm:px-4 min-w-0 overflow-hidden"
        // @ts-expect-error - WebkitAppRegion is not a valid property
        style={{ WebkitAppRegion: 'drag' }}
      >
        {/* @ts-expect-error - WebkitAppRegion is not a valid property */}
        <div className="min-w-0 flex-1 truncate" style={{ WebkitAppRegion: 'no-drag' }}>
          <Breadcrumbs breadcrumbs={breadcrumbs} isAnimatedTitle={path.startsWith('/chat')} />
        </div>
        {/* @ts-expect-error - WebkitAppRegion is not a valid property */}
        <div className="flex items-center gap-1 sm:gap-2 shrink-0" style={{ WebkitAppRegion: 'no-drag' }}>
          <span className="text-xs text-muted-foreground hidden lg:inline">This is v{appVersion},</span>
          <span className="text-xs text-muted-foreground hidden sm:inline lg:hidden">v{appVersion}</span>
          <Button
            className="h-6 text-xs px-2 sm:px-3 bg-gray-500 hover:bg-gray-600 text-white"
            size="sm"
            onClick={handleReportBug}
            title="Report a bug"
          >
            <span className="hidden sm:inline">report a</span>
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
    </header>
  );
}
