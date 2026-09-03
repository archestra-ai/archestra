"use client";

import { Search } from "lucide-react";
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useRef,
  useState,
} from "react";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { iconToDataUrl, type ServiceIcon } from "./service-logo-picker.utils";

const PAGE_SIZE = 120;

interface ServiceIconsResponse {
  data: ServiceIcon[];
  total: number;
}

interface ServiceLogoPickerProps {
  onSelect: (dataUrl: string) => void;
}

export function ServiceLogoPicker({ onSelect }: ServiceLogoPickerProps) {
  const [icons, setIcons] = useState<ServiceIcon[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loadMoreFailed, setLoadMoreFailed] = useState(false);
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const scrollRef = useRef<HTMLDivElement>(null);
  const requestVersionRef = useRef(0);

  useEffect(() => {
    const requestVersion = ++requestVersionRef.current;
    const abortController = new AbortController();
    const searchParams = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (deferredQuery.trim()) {
      searchParams.set("q", deferredQuery.trim());
    }

    setLoading(true);
    setLoadingMore(false);
    setLoadFailed(false);
    setLoadMoreFailed(false);

    fetch(`/api/service-icons?${searchParams}`, {
      signal: abortController.signal,
    })
      .then((response) => {
        if (!response.ok) {
          throw new Error("Failed to load service icons");
        }
        return response.json() as Promise<ServiceIconsResponse>;
      })
      .then((result) => {
        if (requestVersion !== requestVersionRef.current) return;
        setIcons(result.data);
        setTotal(result.total);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") {
          return;
        }
        if (requestVersion === requestVersionRef.current) {
          setLoadFailed(true);
        }
      })
      .finally(() => {
        if (
          !abortController.signal.aborted &&
          requestVersion === requestVersionRef.current
        ) {
          setLoading(false);
        }
      });

    return () => abortController.abort();
  }, [deferredQuery]);

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

  const handleScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      const el = e.currentTarget;
      const nearBottom =
        el.scrollTop + el.clientHeight >= el.scrollHeight - 100;
      if (!nearBottom || loadingMore || icons.length >= total) return;

      const searchParams = new URLSearchParams({
        limit: String(PAGE_SIZE),
        offset: String(icons.length),
      });
      if (deferredQuery.trim()) {
        searchParams.set("q", deferredQuery.trim());
      }

      setLoadingMore(true);
      setLoadMoreFailed(false);
      const requestVersion = requestVersionRef.current;
      fetch(`/api/service-icons?${searchParams}`)
        .then((response) => {
          if (!response.ok) {
            throw new Error("Failed to load more service icons");
          }
          return response.json() as Promise<ServiceIconsResponse>;
        })
        .then((result) => {
          if (requestVersion !== requestVersionRef.current) return;
          setIcons((current) => [...current, ...result.data]);
          setTotal(result.total);
        })
        .catch(() => {
          if (requestVersion === requestVersionRef.current) {
            setLoadMoreFailed(true);
          }
        })
        .finally(() => {
          if (requestVersion === requestVersionRef.current) {
            setLoadingMore(false);
          }
        });
    },
    [deferredQuery, icons.length, loadingMore, total],
  );

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
        ) : loadFailed ? (
          <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
            <span>Could not load logos</span>
          </div>
        ) : icons.length === 0 ? (
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
              {icons.map((icon) => (
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
            {icons.length < total && (
              <p className="text-xs text-muted-foreground text-center py-2">
                {loadingMore
                  ? "Loading more..."
                  : loadMoreFailed
                    ? "Could not load more logos"
                    : `Scroll for more (${total - icons.length} remaining)`}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
