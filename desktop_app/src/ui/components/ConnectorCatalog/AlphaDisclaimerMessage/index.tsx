import { Info } from 'lucide-react';

import { Alert, AlertDescription } from '@ui/components/ui/alert';

interface AlphaDisclaimerMessageProps {}

export default function AlphaDisclaimerMessage(_props: AlphaDisclaimerMessageProps) {
  return (
    <Alert className="bg-blue-50 border-blue-200 dark:bg-blue-950/20 dark:border-blue-900">
      <Info className="h-4 w-4 text-blue-600 dark:text-blue-400" />
      <AlertDescription className="text-blue-900 dark:text-blue-100">
        <p>
          Archestra's{' '}
          <a
            href="http://localhost:3000/mcp-catalog/"
            className="underline hover:no-underline font-medium"
            onClick={(e) => {
              e.preventDefault();
              window.electronAPI.openExternal('http://localhost:3000/mcp-catalog/');
            }}
          >
            MCP Catalog
          </a>{' '}
          is currently in alpha-stage. While testing out any of the connectors, if you experience <em>any</em> issues,
          feel free to open an issue by simply clicking the git icon on the catalog entry. 🙂
        </p>
      </AlertDescription>
    </Alert>
  );
}
