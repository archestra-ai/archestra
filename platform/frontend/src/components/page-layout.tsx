import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

// Helper to determine if a tab is active
// Sort tabs by href length descending so we match the most specific first
function isTabActive(
  pathname: string,
  tabHref: string,
  allTabs: { href: string }[],
) {
  // Sort tabs by href length (longest first)
  const sortedTabs = [...allTabs].sort((a, b) => b.href.length - a.href.length);

  // Find the first tab that matches
  for (const tab of sortedTabs) {
    if (pathname === tab.href || pathname.startsWith(`${tab.href}/`)) {
      return tab.href === tabHref;
    }
  }

  // Fallback to includes for backwards compatibility
  return pathname.includes(tabHref);
}

export function PageLayout({
  title,
  description,
  children,
  tabs = [],
  actionButton,
}: {
  children: React.ReactNode;
  tabs?: { label: string; href: string }[];
  title: React.ReactNode;
  description: React.ReactNode;
  actionButton?: React.ReactNode;
}) {
  const pathname = usePathname();
  const maxWidth = "max-w-[1680px]";

  return (
    <div className="flex h-full w-full flex-col">
      <div className="border-b border-border bg-card/30">
        <div className={cn("mx-auto", maxWidth, "px-6 pt-6 md:px-6")}>
          <div className="flex justify-between items-start sm:flex-row sm:justify-between sm:items-start">
            <h1 className="mb-2 text-2xl font-semibold tracking-tight">
              {title}
            </h1>
            {actionButton}
          </div>
          <div className="text-sm text-muted-foreground mb-6">
            {description}
          </div>
          {tabs.length > 0 && (
            <div className="flex gap-4 mb-0 overflow-x-auto whitespace-nowrap">
              {tabs.map((tab) => {
                const isActive = isTabActive(pathname, tab.href, tabs);
                return (
                  <Link
                    key={tab.href}
                    href={tab.href}
                    className={cn(
                      "relative pb-3 text-sm font-medium transition-colors hover:text-foreground",
                      isActive ? "text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {tab.label}
                    {isActive && (
                      <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary" />
                    )}
                  </Link>
                );
              })}
            </div>
          )}
          {!tabs.length && <div className="mb-6" />}
        </div>
      </div>
      <div className="w-full h-full">
        <div className={cn("mx-auto w-full", maxWidth, "px-6 py-6 md:px-6")}>
          {children}
        </div>
      </div>
    </div>
  );
}
