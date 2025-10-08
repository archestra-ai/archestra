'use client';

import { Loader2, RefreshCw, Activity, Shield, Eye } from 'lucide-react';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';

interface WaitingForFirstRequestProps {
  onRefresh?: () => void;
}

export function WaitingForFirstRequest({
  onRefresh,
}: WaitingForFirstRequestProps) {
  return (
    <div className="flex items-center justify-center min-h-[60vh]">
      <Card className="w-full max-w-2xl">
        <CardHeader className="text-center">
          <div className="flex justify-center mb-4">
            <Loader2 className="h-12 w-12 animate-spin text-primary" />
          </div>
          <CardTitle className="text-2xl">Waiting for First Request</CardTitle>
          <CardDescription>
            The platform is ready and waiting to process your first chat
            interaction
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="bg-muted p-4 rounded-lg">
            <h3 className="font-semibold mb-2 text-sm">Getting Started:</h3>
            <ol className="list-decimal list-inside space-y-1 text-sm text-muted-foreground">
              <li>Send your first message through the chat interface</li>
              <li>The platform will process your request</li>
              <li>This page will automatically check for updates</li>
            </ol>
          </div>

          <div className="bg-blue-50 dark:bg-blue-950 p-4 rounded-lg border border-blue-200 dark:border-blue-800">
            <h3 className="font-semibold mb-2 text-sm text-blue-900 dark:text-blue-100 flex items-center gap-2">
              <Activity className="h-4 w-4" />
              Platform Status:
            </h3>
            <p className="text-sm text-blue-800 dark:text-blue-200">
              ✓ All systems operational
            </p>
            <p className="text-sm text-blue-800 dark:text-blue-200">
              ✓ Ready to receive requests
            </p>
            <p className="text-sm text-blue-800 dark:text-blue-200">
              ✓ Proxy services active
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="bg-purple-50 dark:bg-purple-950 p-4 rounded-lg border border-purple-200 dark:border-purple-800">
              <h3 className="font-semibold mb-2 text-sm text-purple-900 dark:text-purple-100 flex items-center gap-2">
                <Shield className="h-4 w-4" />
                Error Tracking
              </h3>
              <p className="text-xs text-purple-800 dark:text-purple-200">
                Sentry monitoring active
              </p>
              <p className="text-xs text-purple-700 dark:text-purple-300 mt-1">
                Real-time error detection and alerts
              </p>
            </div>

            <div className="bg-indigo-50 dark:bg-indigo-950 p-4 rounded-lg border border-indigo-200 dark:border-indigo-800">
              <h3 className="font-semibold mb-2 text-sm text-indigo-900 dark:text-indigo-100 flex items-center gap-2">
                <Eye className="h-4 w-4" />
                Performance Monitoring
              </h3>
              <p className="text-xs text-indigo-800 dark:text-indigo-200">
                Datadog observability enabled
              </p>
              <p className="text-xs text-indigo-700 dark:text-indigo-300 mt-1">
                Full-stack monitoring and analytics
              </p>
            </div>
          </div>

          <div className="bg-amber-50 dark:bg-amber-950 p-4 rounded-lg border border-amber-200 dark:border-amber-800">
            <h3 className="font-semibold mb-2 text-sm text-amber-900 dark:text-amber-100">
              📡 Proxy Information
            </h3>
            <p className="text-xs text-amber-800 dark:text-amber-200">
              All requests are routed through our secure proxy infrastructure
            </p>
            <ul className="mt-2 space-y-1 text-xs text-amber-700 dark:text-amber-300">
              <li>• SSL/TLS encryption enabled</li>
              <li>• Request/response logging active</li>
              <li>• Rate limiting configured</li>
              <li>• Health checks running every 30s</li>
            </ul>
          </div>

          {onRefresh && (
            <Button variant="outline" className="w-full" onClick={onRefresh}>
              <RefreshCw className="mr-2 h-4 w-4" />
              Check for Updates
            </Button>
          )}

          <p className="text-xs text-center text-muted-foreground">
            Auto-checking every 5 seconds...
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
