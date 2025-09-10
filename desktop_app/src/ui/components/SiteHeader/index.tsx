import { useLocation, useNavigate } from '@tanstack/react-router';
import { Plus, SidebarIcon } from 'lucide-react';
import { useEffect, useState } from 'react';

import { ThemeToggler } from '@ui/components/ThemeToggler';
import { Button } from '@ui/components/ui/button';
import { Separator } from '@ui/components/ui/separator';
import { useSidebar } from '@ui/components/ui/sidebar';
import { useChatStore } from '@ui/stores';

import { Breadcrumbs } from './Breadcrumbs';

export function SiteHeader() {
  const { toggleSidebar } = useSidebar();
  const { getCurrentChatTitle, createNewChat } = useChatStore();
  const navigate = useNavigate();
  const location = useLocation();
  const [appVersion, setAppVersion] = useState<string>('');

  useEffect(() => {
    window.electronAPI.appVersion().then(setAppVersion);
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

  return (
    <header className="bg-background sticky top-0 z-50 flex w-full items-center border-b">
      <div
        className="flex h-[var(--header-height)] w-64 items-center gap-2 px-4 pl-20 border-r"
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
          className="h-8 cursor-pointer"
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
          New Chat
        </Button>
      </div>
      <div
        className="flex h-[var(--header-height)] flex-1 items-center justify-between px-4"
        // @ts-expect-error - WebkitAppRegion is not a valid property
        style={{ WebkitAppRegion: 'drag' }}
      >
        {/* @ts-expect-error - WebkitAppRegion is not a valid property */}
        <div style={{ WebkitAppRegion: 'no-drag' }}>
          <Breadcrumbs breadcrumbs={breadcrumbs} isAnimatedTitle={path.startsWith('/chat')} />
        </div>
        {/* @ts-expect-error - WebkitAppRegion is not a valid property */}
        <div className="flex items-center gap-2" style={{ WebkitAppRegion: 'no-drag' }}>
          {appVersion && <span className="text-xs text-muted-foreground mr-2">v{appVersion}</span>}
          <ThemeToggler />
        </div>
      </div>
    </header>
  );
}
