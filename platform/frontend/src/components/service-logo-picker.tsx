"use client";

import { Search } from "lucide-react";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  buildIconList,
  filterIcons,
  iconToDataUrl,
  type ServiceIcon,
} from "./service-logo-picker.utils";

interface ServiceLogoPickerProps {
  onSelect: (dataUrl: string) => void;
}

export function ServiceLogoPicker({ onSelect }: ServiceLogoPickerProps) {
  const [icons, setIcons] = useState<ServiceIcon[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    import("simple-icons").then((module) => {
      setIcons(buildIconList(module));
      setLoading(false);
    });
  }, []);

  const filtered = useMemo(
    () => filterIcons(icons, deferredQuery),
    [icons, deferredQuery],
  );

  // Reset scroll when search changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally trigger on deferredQuery change
  useEffect(() => {
    scrollRef.current?.scrollTo(0, 0);
  }, [deferredQuery]);

  const handleSelect = useCallback(
    (icon: ServiceIcon) => {
      onSelect(iconToDataUrl(icon));
    },
    [onSelect],
  );

  // Only render first N icons for performance, load more on scroll
  const [visibleCount, setVisibleCount] = useState(120);

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally reset on search change
  useEffect(() => {
    setVisibleCount(120);
  }, [deferredQuery]);

  const handleScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      const el = e.currentTarget;
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 100) {
        setVisibleCount((prev) => Math.min(prev + 120, filtered.length));
      }
    },
    [filtered.length],
  );

  const visibleIcons = filtered.slice(0, visibleCount);

  return (
    <div className="flex flex-col">
      <div className="p-2 border-b">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            aria-label="Search logos"
            placeholder="Search logos..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-8 h-8 text-sm"
          />
        </div>
      </div>
      <div
        ref={scrollRef}
        className="overflow-y-auto p-2"
        style={{ height: 280 }}
        onScroll={handleScroll}
      >
        {loading ? (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
            <span>Loading logos...</span>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
            <span>No logos found</span>
          </div>
        ) : (
          <>
            {!deferredQuery && (
              <p className="text-xs text-muted-foreground px-1 pb-1.5">
                Popular services
              </p>
            )}
            {/*
              Four columns, not six: the label below each logo now wraps
              instead of truncating, and at six the cell was narrow enough that
              ordinary names ("Kubernetes", "PostgreSQL") broke mid-word. Four
              fits the large majority on one line and caps the rest at two.
            */}
            <div className="grid grid-cols-4 gap-1">
              {visibleIcons.map((icon) => (
                <button
                  key={icon.slug}
                  type="button"
                  title={icon.title}
                  onClick={() => handleSelect(icon)}
                  className={cn(
                    "flex flex-col items-center gap-1 rounded-md p-1.5 hover:bg-accent transition-colors cursor-pointer",
                  )}
                >
                  {icon.svgMarkup ? (
                    <span
                      className="h-6 w-6 shrink-0 [&>svg]:h-full [&>svg]:w-full"
                      // biome-ignore lint/security/noDangerouslySetInnerHtml: static trusted SVG from CUSTOM_ICONS
                      dangerouslySetInnerHTML={{ __html: icon.svgMarkup }}
                    />
                  ) : (
                    <svg
                      role="img"
                      aria-label={icon.title}
                      viewBox="0 0 24 24"
                      fill={`#${icon.hex}`}
                      className="h-6 w-6 shrink-0"
                    >
                      <path d={icon.path} />
                    </svg>
                  )}
                  {/*
                    Wraps rather than truncating. Truncating turned "Slackware"
                    into "Slack…", which reads as Slack itself — the label has
                    to stay legible, and it is the only thing separating two
                    brands whose logos look nothing alike. `break-words` is the
                    backstop for a single token too long for even this cell.
                  */}
                  <span className="text-[10px] leading-tight text-muted-foreground w-full text-center text-balance break-words">
                    {icon.title}
                  </span>
                </button>
              ))}
            </div>
            {visibleCount < filtered.length && (
              <p className="text-xs text-muted-foreground text-center py-2">
                Scroll for more ({filtered.length - visibleCount} remaining)
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
