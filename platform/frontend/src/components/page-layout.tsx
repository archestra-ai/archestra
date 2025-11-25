import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

export function PageLayout({
  title,
  description,
  children,
  tabs = [],
  actionButton,
}: {
  children: React.ReactNode;
  tabs?: { label: string; href: string }[];
  title: string;
  description: React.ReactNode;
  actionButton?: React.ReactNode;
}) {
  const pathname = usePathname();
  return (
    <div className="flex h-full w-full flex-col">
      <div className="border-b border-border bg-card/30">
        <div className="mx-auto max-w-7xl px-4 pt-8 md:px-8">
          <div className="flex justify-between items-start">
            <h1 className="mb-2 text-2xl font-semibold tracking-tight">
              {title}
            </h1>
            {actionButton}
          </div>
          <div className="text-sm text-muted-foreground mb-8">
            {description}
          </div>
          {tabs.length > 0 && (
            <div className="flex gap-4 mb-0">
              {tabs.map((tab) => (
                <Link
                  key={tab.href}
                  href={tab.href}
                  className={cn(
                    "relative pb-3 text-sm font-medium transition-colors hover:text-foreground",
                    pathname.includes(tab.href)
                      ? "text-foreground"
                      : "text-muted-foreground",
                  )}
                >
                  {tab.label}
                  {pathname.includes(tab.href) && (
                    <span className="absolute bottom-0 left-0 right-0 h-0.5 bg-primary" />
                  )}
                </Link>
              ))}
            </div>
          )}
          {!tabs.length && <div className="mb-8" />}
        </div>
      </div>
      {children}
    </div>
  );
}
