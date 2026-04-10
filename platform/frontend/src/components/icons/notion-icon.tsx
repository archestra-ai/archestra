import React from 'react';

export function NotionIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="currentColor"
      {...props}
    >
      <path d="M16 11H8V6h8v5zm0 1H8v5h8v-5zm-5-11v4h-4V1h4zm0 22v-4h-4v4h4zm11-11v4h-4v-4h4zm-4-11v4h-4V1h4z" />
    </svg>
  );
}
