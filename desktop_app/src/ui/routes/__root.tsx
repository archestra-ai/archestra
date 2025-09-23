import { Outlet, createRootRoute } from '@tanstack/react-router';

import Sidebar from '@ui/components/Sidebar';
import { SidebarInset } from '@ui/components/ui/sidebar';
import { ChatAgentProvider } from '@ui/contexts/chat-agent-context';

export const Route = createRootRoute({
  component: () => (
    <>
      <ChatAgentProvider>
        <Sidebar>
          <SidebarInset className="overflow-hidden h-full">
            <main className="flex-1 space-y-4 p-4 h-full overflow-y-auto">
              <Outlet />
            </main>
          </SidebarInset>
        </Sidebar>
      </ChatAgentProvider>
      {/* Matvey, disabling this */}
      {/* {config.debug && <TanStackRouterDevtools />} */}
    </>
  ),
});
