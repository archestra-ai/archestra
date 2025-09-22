import { useEffect, useState } from 'react';

import { cn } from '@ui/lib/utils/tailwind';

interface VoiceAnimationProps {
  isListening: boolean;
  className?: string;
}

export default function VoiceAnimation({ isListening, className }: VoiceAnimationProps) {
  const [audioLevels, setAudioLevels] = useState<number[]>([0.2, 0.4, 0.6, 0.8, 0.5, 0.3]);

  useEffect(() => {
    if (!isListening) {
      setAudioLevels([0.1, 0.1, 0.1, 0.1, 0.1, 0.1]);
      return;
    }

    // Simulate audio levels with random variations
    const interval = setInterval(() => {
      setAudioLevels((prev) => prev.map(() => Math.random() * 0.8 + 0.2));
    }, 150);

    return () => clearInterval(interval);
  }, [isListening]);

  if (!isListening) {
    return (
      <div className={cn('flex items-center justify-center space-x-0.5', className)}>
        {audioLevels.map((_, i) => (
          <div
            key={i}
            className="w-0.5 bg-gray-400 rounded-full transition-all duration-200"
            style={{ height: '4px' }}
          />
        ))}
      </div>
    );
  }

  return (
    <div className={cn('flex items-center justify-center space-x-0.5', className)}>
      {audioLevels.map((level, i) => (
        <div
          key={i}
          className="bg-gradient-to-t from-red-500 to-orange-400 rounded-full transition-all duration-150 ease-out"
          style={{
            width: '2px',
            height: `${Math.max(4, level * 16)}px`,
            transform: `scaleY(${0.5 + level * 0.5})`,
          }}
        />
      ))}
    </div>
  );
}
