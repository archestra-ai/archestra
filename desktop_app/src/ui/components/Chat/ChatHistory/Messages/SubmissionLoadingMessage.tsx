import { Clock, Send } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Badge } from '@ui/components/ui/badge';

interface SubmissionLoadingMessageProps {
  startTime?: number;
}

export default function SubmissionLoadingMessage({ startTime = Date.now() }: SubmissionLoadingMessageProps) {
  const [elapsedTime, setElapsedTime] = useState(0);
  const [dots, setDots] = useState('');

  useEffect(() => {
    const interval = setInterval(() => {
      setElapsedTime(Date.now() - startTime);
    }, 1000);

    return () => clearInterval(interval);
  }, [startTime]);

  // Animate dots
  useEffect(() => {
    const interval = setInterval(() => {
      setDots((prev) => {
        if (prev === '...') return '';
        return prev + '.';
      });
    }, 400);

    return () => clearInterval(interval);
  }, []);

  const formatElapsedTime = (ms: number) => {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);

    if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    }
    return `${seconds}s`;
  };

  const isLongPrep = elapsedTime > 3000;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <Send className="h-4 w-4 animate-pulse text-blue-500" />
          <span className="text-sm text-muted-foreground">Preparing your request{dots}</span>
        </div>

        {isLongPrep && (
          <Badge variant="outline" className="flex items-center gap-1.5 text-xs">
            <Clock className="h-3 w-3" />
            {formatElapsedTime(elapsedTime)}
          </Badge>
        )}
      </div>

      {isLongPrep && (
        <p className="text-xs text-muted-foreground">Connecting to the model and preparing your request...</p>
      )}
    </div>
  );
}
