import { siApple, siLinux } from "simple-icons";
import { cn } from "@/lib/utils";
import type { ConnectPlatformOption } from "./platform.utils";

// simple-icons omits the Windows mark (trademark), so the classic four-pane
// Windows logo is inlined here.
const WINDOWS_PATH =
  "M0 3.449L9.75 2.1v9.451H0m10.949-9.602L24 0v11.4H10.949M0 12.6h9.75v9.451L0 20.699M10.949 12.6H24V24l-12.9-1.801";

// Decorative: the adjacent text label already names the OS, so the marks are
// hidden from assistive tech to avoid double-announcing.
function Glyph({ path, className }: { path: string; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="currentColor"
      className={cn("size-3.5 shrink-0", className)}
    >
      <path d={path} />
    </svg>
  );
}

/**
 * Brand logo(s) for a platform option. The combined macOS / Linux option shows
 * both marks; Windows shows its own.
 */
export function OsLogos({
  platform,
  className,
}: {
  platform: ConnectPlatformOption;
  className?: string;
}) {
  if (platform === "windows") {
    return <Glyph path={WINDOWS_PATH} className={className} />;
  }
  return (
    <span className="inline-flex items-center gap-1">
      <Glyph path={siApple.path} className={className} />
      <Glyph path={siLinux.path} className={className} />
    </span>
  );
}
