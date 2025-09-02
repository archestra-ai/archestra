import { Outlet, createRootRoute } from '@tanstack/react-router';

import Sidebar from '@ui/components/Sidebar';
import { SidebarInset } from '@ui/components/ui/sidebar';

export const Route = createRootRoute({
  component: () => (
    <>
      <Sidebar>
        <SidebarInset className="overflow-hidden h-full">
          <main className="flex-1 space-y-4 p-4 h-full overflow-y-auto">
            <Outlet />
          </main>
        </SidebarInset>
      </Sidebar>
      {/* Matvey, disabling this */}
      {/* {config.debug && <TanStackRouterDevtools />} */}
    </>
  ),
});
