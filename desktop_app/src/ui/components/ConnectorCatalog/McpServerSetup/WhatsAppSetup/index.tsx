/** WhatsApp setup wizard, which shows a QR code and waits for it to be scanned */
import { AlertCircle, CheckCircle, RefreshCw } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';

import { type MCPSetup } from '@backend/websocket';
import { Button } from '@ui/components/ui/button';
import { DialogDescription, DialogTitle } from '@ui/components/ui/dialog';
import { restartMcpServer } from '@ui/lib/clients/archestra/api/gen';

/**
 * Converts ASCII QR code to SVG React component
 * @param asciiQr - The ASCII QR code string
 * @param cellSize - Size of each QR code cell in pixels
 * @returns React SVG component
 */
function asciiQrToSvg(asciiQr: string, cellSize: number = 10): React.ReactElement | null {
  const lines = asciiQr.trim().split('\n');
  if (lines.length === 0) return null;

  const width = lines[0].length;
  const height = lines.length;
  const svgWidth = (width * cellSize) / 2;
  const svgHeight = height * cellSize;

  const rects: React.ReactElement[] = [];

  for (let y = 0; y < height; y++) {
    const line = lines[y];
    for (let x = 0; x < line.length; x++) {
      const char = line[x];
      const rectX = (x * cellSize) / 2;
      const rectY = y * cellSize;

      // Handle different ASCII QR code characters
      switch (char) {
        case '█': // Full block - black square
          rects.push(
            <rect key={`${x}-${y}`} x={rectX} y={rectY} width={cellSize / 2} height={cellSize} fill="black" />
          );
          break;
        case '▄': // Lower half block - black bottom half
          rects.push(
            <rect
              key={`${x}-${y}`}
              x={rectX}
              y={rectY + cellSize / 2}
              width={cellSize / 2}
              height={cellSize / 2}
              fill="black"
            />
          );
          break;
        case '▀': // Upper half block - black top half
          rects.push(
            <rect key={`${x}-${y}`} x={rectX} y={rectY} width={cellSize / 2} height={cellSize / 2} fill="black" />
          );
          break;
        case ' ': // Space - white square (already white background)
          break;
        default:
          // For any other characters, treat as black for safety
          rects.push(
            <rect key={`${x}-${y}`} x={rectX} y={rectY} width={cellSize / 2} height={cellSize} fill="black" />
          );
          break;
      }
    }
  }

  return (
    <svg
      width={svgWidth}
      height={svgHeight}
      viewBox={`0 0 ${svgWidth} ${svgHeight}`}
      xmlns="http://www.w3.org/2000/svg"
      className="max-w-full max-h-96"
    >
      <rect width={svgWidth} height={svgHeight} fill="white" />
      {rects}
    </svg>
  );
}

/** Renders WhatsApp QR Code from ASCII symbols */
export default function WhatsAppSetup({
  content: ascii,
  status,
  serverId,
  closeDialog,
}: {
  content: string;
  status: MCPSetup['status'];
  serverId: string;
  closeDialog: () => void;
}) {
  const SvgQrCode = ascii ? asciiQrToSvg(ascii) : '';
  const isSuccess = status === 'success';
  const isError = status === 'error';

  const [isRestarting, setIsRestarting] = useState(false);

  // Auto-close dialog after 2 seconds on success
  useEffect(() => {
    if (isSuccess) {
      const timer = setTimeout(closeDialog, 2000);
      return () => clearTimeout(timer);
    }
  }, [isSuccess]);

  // Reset restarting state when status changes from error to pending (new QR code arrives)
  useEffect(() => {
    if (status === 'pending' && isRestarting) {
      setIsRestarting(false);
    }
  }, [status, isRestarting]);

  const handleRetry = async () => {
    try {
      setIsRestarting(true);
      await restartMcpServer({ path: { id: serverId } });
      // Keep dialog open and show loading state - new QR code will arrive soon
    } catch (error) {
      console.error('Failed to restart server:', error);
      // Could show an error toast here
      setIsRestarting(false);
    }
    // Note: We don't set isRestarting to false here because we want to keep showing
    // the loading state until a new QR code arrives (status changes from 'error')
  };

  if (isSuccess) {
    return (
      <>
        <DialogTitle className="flex items-center gap-2">
          <CheckCircle className="h-5 w-5 text-green-500" />
          WhatsApp Connected Successfully
        </DialogTitle>
        <DialogDescription>
          Your WhatsApp account has been linked to Archestra. You can now use WhatsApp tools in your conversations.
        </DialogDescription>

        <div className="flex justify-center p-4 rounded-md min-h-[200px] items-center">
          <div className="text-center space-y-2">
            <CheckCircle className="h-12 w-12 text-green-500 mx-auto animate-pulse" />
            <p className="text-sm text-muted-foreground">Connection established!</p>
            <p className="text-xs text-muted-foreground opacity-75">This dialog will close automatically...</p>
          </div>
        </div>

        <div className="text-sm text-muted-foreground text-center invisible">
          <p>Open WhatsApp → Settings → Linked Devices → Tap "Link device", then scan this code.</p>
          <p className="text-xs mt-2 opacity-75">QR code expires after a few minutes for security.</p>
        </div>
      </>
    );
  }

  if (isError) {
    return (
      <>
        <DialogTitle className="flex items-center gap-2">
          <AlertCircle className="h-5 w-5 text-red-500" />
          {isRestarting ? 'Restarting WhatsApp Server...' : 'WhatsApp Setup Failed'}
        </DialogTitle>
        <DialogDescription>
          {isRestarting
            ? 'Restarting the server to generate a new QR code. This may take a few moments.'
            : 'The pairing process has expired or failed. Restarting the servers will start a fresh pairing session.'}
        </DialogDescription>

        <div className="flex justify-center p-4 rounded-md min-h-[200px] items-center">
          <div className="text-center space-y-4">
            {isRestarting ? (
              <>
                <RefreshCw className="h-12 w-12 text-blue-500 mx-auto animate-spin" />
                <div className="space-y-2">
                  <p className="text-sm text-muted-foreground">Restarting server...</p>
                  <p className="text-xs text-muted-foreground opacity-75">A new QR code will appear shortly</p>
                </div>
              </>
            ) : (
              <>
                <AlertCircle className="h-12 w-12 text-red-500 mx-auto" />
                <div className="space-y-2">
                  <p className="text-sm text-muted-foreground">Setup failed</p>
                  <Button onClick={handleRetry} disabled={isRestarting} className="flex items-center gap-2">
                    <RefreshCw className="h-4 w-4" />
                    Restart Server
                  </Button>
                </div>
              </>
            )}
          </div>
        </div>

        <div className="text-sm text-muted-foreground text-center invisible">
          <p>Open WhatsApp → Settings → Linked Devices → Tap "Link device", then scan this code.</p>
          <p className="text-xs mt-2 opacity-75">QR code expires after a few minutes for security.</p>
        </div>
      </>
    );
  }

  return (
    <>
      <DialogTitle className="flex items-center gap-2">Connect WhatsApp</DialogTitle>
      <DialogDescription>
        Scan this QR code with your phone to connect your WhatsApp account to Archestra.
      </DialogDescription>

      <div className="flex justify-center p-4 rounded-md min-h-[200px] items-center">{SvgQrCode}</div>

      <div className="text-sm text-muted-foreground text-center">
        <p>Open WhatsApp → Settings → Linked Devices → Tap "Link device", then scan this code.</p>
        <p className="text-xs mt-2 opacity-75">QR code expires after a few minutes for security.</p>
      </div>
    </>
  );
}
