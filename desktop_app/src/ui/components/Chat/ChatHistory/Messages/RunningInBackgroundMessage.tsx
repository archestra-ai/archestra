import { Clock } from 'lucide-react';
import { useEffect, useState } from 'react';

import { useChatStore } from '@ui/stores';

interface RunningInBackgroundMessageProps {
  chatId: number;
}

export default function RunningInBackgroundMessage({ chatId }: RunningInBackgroundMessageProps) {
  const [dots, setDots] = useState('');
  const { selectChat } = useChatStore();

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

  const handleRefresh = () => {
    selectChat(chatId);
  };

  useEffect(() => {
    const intervalId = setInterval(() => {
      handleRefresh();
    }, 2000);
    return () => clearInterval(intervalId);
  }, []);

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Clock className="h-4 w-4 text-orange-500" />
        <span className="text-sm text-muted-foreground">Waiting for response{dots}</span>
      </div>

      <p className="text-xs text-muted-foreground">
        We're running your request in the background and the response will be ready soon...
      </p>
    </div>
  );
}
