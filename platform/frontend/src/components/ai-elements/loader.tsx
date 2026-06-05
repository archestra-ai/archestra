import type { HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

type LoaderIconProps = {
  size?: number;
};

const LoaderIcon = ({ size = 16 }: LoaderIconProps) => (
  <svg
    height={size}
    strokeLinejoin="round"
    style={{ color: "currentcolor" }}
    viewBox="0 0 16 16"
    width={size}
  >
    <title>Loader</title>
    <g clipPath="url(#clip0_2393_1490)">
      <path d="M8 0V4" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M8 16V12"
        opacity="0.5"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M3.29773 1.52783L5.64887 4.7639"
        opacity="0.9"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M12.7023 1.52783L10.3511 4.7639"
        opacity="0.1"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M12.7023 14.472L10.3511 11.236"
        opacity="0.4"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M3.29773 14.472L5.64887 11.236"
        opacity="0.6"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M15.6085 5.52783L11.8043 6.7639"
        opacity="0.2"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M0.391602 10.472L4.19583 9.23598"
        opacity="0.7"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M15.6085 10.4722L11.8043 9.2361"
        opacity="0.3"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M0.391602 5.52783L4.19583 6.7639"
        opacity="0.8"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </g>
    <defs>
      <clipPath id="clip0_2393_1490">
        <rect fill="white" height="16" width="16" />
      </clipPath>
    </defs>
  </svg>
);

export type LoaderProps = HTMLAttributes<HTMLDivElement> & {
  size?: number;
};

export const Loader = ({ className, size = 16, ...props }: LoaderProps) => (
  <div
    className={cn(
      "inline-flex animate-spin items-center justify-center",
      className,
    )}
    {...props}
  >
    <LoaderIcon size={size} />
  </div>
);

export type GoldenSnitchLoaderProps = HTMLAttributes<HTMLOutputElement> & {
  size?: number;
};

export const GoldenSnitchLoader = ({
  className,
  size = 18,
  ...props
}: GoldenSnitchLoaderProps) => (
  <output
    aria-label="Golden Snitch loading"
    className={cn("inline-flex items-center justify-center", className)}
    {...props}
  >
    <svg
      className="overflow-visible"
      height={size}
      viewBox="0 0 24 16"
      width={Math.round(size * 1.5)}
    >
      <title>Golden Snitch</title>
      <g className="origin-center [animation:snitch-dart_900ms_ease-in-out_infinite]">
        <path
          d="M10 8c-2.8-2.6-5.3-3.6-8-3.2 2.1 1.1 3.9 2.4 5.4 4C5.8 9 4.1 9.7 2.3 11.1c2.8.2 5.3-.7 7.7-3.1Z"
          fill="currentColor"
          opacity="0.45"
        />
        <path
          d="M14 8c2.8-2.6 5.3-3.6 8-3.2-2.1 1.1-3.9 2.4-5.4 4 1.6.2 3.3.9 5.1 2.3-2.8.2-5.3-.7-7.7-3.1Z"
          fill="currentColor"
          opacity="0.45"
        />
        <circle cx="12" cy="8" fill="oklch(0.82 0.17 83)" r="3.2" />
        <circle cx="10.9" cy="7" fill="white" opacity="0.55" r="0.9" />
      </g>
    </svg>
  </output>
);
