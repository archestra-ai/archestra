import { SidebarIcon } from 'lucide-react';
import React from 'react';

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { useSidebar } from '@/components/ui/sidebar';

import { TypewriterText } from './TypewriterText';
import { ModeToggle } from './mode-toggle';

interface SiteHeaderProps {
  title?: string;
  breadcrumbs?: string[];
  isAnimatedTitle?: boolean;
}

export function SiteHeader(props: SiteHeaderProps) {
  const { toggleSidebar } = useSidebar();

  return (
    <header className="bg-background sticky top-0 z-50 flex w-full items-center border-b">
      <div className="flex h-[var(--header-height)] w-full items-center gap-2 px-4 pl-[80px]" data-tauri-drag-region>
        <Button className="h-8 w-8" variant="ghost" size="icon" onClick={toggleSidebar}>
          <SidebarIcon />
        </Button>
        {/* <Button
          className="h-8 w-8"
          variant="ghost"
          size="icon"
          onClick={() => {
            router.history.back();
          }}
          disabled={!useCanGoBack()}
        >
          <ChevronLeft />
        </Button>
        <Button
          className="h-8 w-8"
          variant="ghost"
          size="icon"
          onClick={() => {
            router.history.forward();
          }}
        >
          <ChevronRight />
        </Button> */}
        <Separator orientation="vertical" className="mr-2 h-4" />
        <Breadcrumb className="hidden sm:block">
          <BreadcrumbList>
            <BreadcrumbItem>
              <BreadcrumbLink>Archestra</BreadcrumbLink>
            </BreadcrumbItem>
            {props.breadcrumbs?.map((breadcrumb, index) => (
              <React.Fragment key={`sep-${index}`}>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  {index === (props.breadcrumbs?.length ?? 0) - 1 ? (
                    <BreadcrumbPage>
                      {props.isAnimatedTitle && index === 1 ? <TypewriterText text={breadcrumb} /> : breadcrumb}
                    </BreadcrumbPage>
                  ) : (
                    <BreadcrumbLink>{breadcrumb}</BreadcrumbLink>
                  )}
                </BreadcrumbItem>
              </React.Fragment>
            )) || (
              <>
                <BreadcrumbSeparator />
                <BreadcrumbItem>
                  <BreadcrumbPage>{props.title}</BreadcrumbPage>
                </BreadcrumbItem>
              </>
            )}
          </BreadcrumbList>
        </Breadcrumb>
      </div>
      <div className="flex items-center gap-2 mr-4">
        <ModeToggle />
      </div>
    </header>
  );
}
