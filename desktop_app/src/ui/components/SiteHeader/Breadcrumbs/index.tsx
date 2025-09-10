import React from 'react';

import { TypewriterText } from '@ui/components/TypewriterText';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@ui/components/ui/breadcrumb';

interface BreadcrumbsProps {
  breadcrumbs: string[];
  isAnimatedTitle?: boolean;
}

export function Breadcrumbs({ breadcrumbs, isAnimatedTitle }: BreadcrumbsProps) {
  return (
    <Breadcrumb className="min-w-0 overflow-hidden">
      <BreadcrumbList className="flex-nowrap overflow-hidden">
        <BreadcrumbItem className="shrink-0">
          <BreadcrumbLink className="hidden sm:inline">Archestra</BreadcrumbLink>
          <BreadcrumbLink className="sm:hidden">A</BreadcrumbLink>
        </BreadcrumbItem>
        {breadcrumbs.map((breadcrumb, index) => (
          <React.Fragment key={`sep-${index}`}>
            <BreadcrumbSeparator className="shrink-0" />
            <BreadcrumbItem className={index === breadcrumbs.length - 1 ? 'truncate min-w-0' : 'shrink-0'}>
              {index === breadcrumbs.length - 1 ? (
                <BreadcrumbPage className="truncate block">
                  {isAnimatedTitle && index === 1 ? (
                    <TypewriterText text={breadcrumb} className="truncate" />
                  ) : (
                    <span className="truncate">{breadcrumb}</span>
                  )}
                </BreadcrumbPage>
              ) : (
                <BreadcrumbLink className="truncate">{breadcrumb}</BreadcrumbLink>
              )}
            </BreadcrumbItem>
          </React.Fragment>
        ))}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
