import { Brain } from 'lucide-react';
import { useEffect, useState } from 'react';

import MemoryDialog from '@ui/components/MemoryDialog';
import { Button } from '@ui/components/ui/button';
import { cn } from '@ui/lib/utils/tailwind';
import { useMemoryStore } from '@ui/stores/memory-store';

export default function MemoryIndicator() {
  const { memories, isBlinking } = useMemoryStore();
  const [dialogOpen, setDialogOpen] = useState(false);

  // Get preview text
  const getPreviewText = () => {
    if (!memories || memories.length === 0) return 'No memories yet';
    const count = memories.length;
    if (count === 1) {
      return `1 memory: ${memories[0].name}`;
    }
    return `${count} memories stored`;
  };

  // Add CSS for animation
  useEffect(() => {
    const style = document.createElement('style');
    style.textContent = `
      @keyframes pulse-glow {
        0%, 100% {
          box-shadow: 0 0 0 0 rgba(147, 51, 234, 0);
          border-color: rgba(147, 51, 234, 0.2);
        }
        50% {
          box-shadow: 0 0 20px 5px rgba(147, 51, 234, 0.3);
          border-color: rgba(147, 51, 234, 0.6);
        }
      }
      
      .animate-pulse-glow {
        animation: pulse-glow 1.5s ease-in-out 2;
      }
    `;
    document.head.appendChild(style);

    return () => {
      document.head.removeChild(style);
    };
  }, []);

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setDialogOpen(true)}
        className={cn(
          'w-full justify-start',
          'flex items-center gap-2 px-2 py-1.5',
          'hover:bg-accent',
          'transition-all duration-200',
          isBlinking && 'animate-pulse-glow border border-purple-500/50'
        )}
      >
        <Brain className="h-4 w-4 text-muted-foreground shrink-0" />
        <span className="text-xs text-muted-foreground truncate">{getPreviewText()}</span>
      </Button>

      <MemoryDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </>
  );
}
