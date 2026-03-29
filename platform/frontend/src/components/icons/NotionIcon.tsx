import React from "react";

interface NotionIconProps {
  className?: string;
  size?: number;
}

/**
 * Notion logo icon rendered as an inline SVG.
 * Based on the official Notion brand mark.
 */
export function NotionIcon({ className, size = 24 }: NotionIconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      className={className}
      aria-label="Notion"
      role="img"
    >
      <rect width="100" height="100" rx="18" fill="white" />
      <path
        d="M17.5 18.3c2.8 2.3 3.9 2.1 9.2 1.8l50.1-3c1.1 0 0.2-1.1-0.2-1.2l-8.3-6c-1.6-1.2-3.8-2.6-7.9-2.2L12.2 11.2c-1.9 0.2-2.3 1.1-1.5 1.9l6.8 5.2z"
        fill="#000"
      />
      <path
        d="M20.4 29.3V82c0 2.9 1.4 4 4.7 3.8l54.8-3.2c3.3-0.2 4.1-2.1 4.1-4.5V26.3c0-2.4-0.9-3.7-3-3.5l-57.4 3.3c-2.3 0.2-3.2 1.3-3.2 3.2z"
        fill="white"
        stroke="#000"
        strokeWidth="3"
      />
      <path
        d="M69.4 31.2l-35.4 2.1c-2.1 0.1-2.6 1.2-2.6 2.6v35.3c0 1.5 0.6 2.2 2.4 2.1l37-2.2c1.9-0.1 2.4-1.1 2.4-2.8V33.8c0-1.8-0.7-2.7-3.8-2.6z"
        fill="#000"
      />
      <path
        d="M62.6 39.6l-22 1.3v3.3l5.9-0.4v25l5.2-0.3V43.5l5.9-0.4 5-4.4v1z"
        fill="white"
      />
      <path
        d="M27.4 88.4l-9.7-6.5c-1.3-0.9-1.8-2.1-1.8-3.8V25.2c0-1.5 0.5-2.5 1.8-2.3l3 0.5c-1.2-0.2-1.8 0.7-1.8 2.1v52.5c0 1.5 0.6 2.8 1.8 3.5l6.7 4.4v2.5z"
        fill="#000"
        fillOpacity="0.15"
      />
    </svg>
  );
}

export default NotionIcon;
