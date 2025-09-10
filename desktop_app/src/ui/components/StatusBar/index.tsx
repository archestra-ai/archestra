import { ChevronDown, Container, Cpu, Download, Loader2, Server, Sparkles } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@ui/components/ui/collapsible';
import { Progress } from '@ui/components/ui/progress';
import { cn } from '@ui/lib/utils/tailwind';
import { useStatusBarStore } from '@ui/stores/status-bar-store';

const taskIcons = {
  runtime: <Container className="h-3 w-3" />,
  server: <Server className="h-3 w-3" />,
  download: <Download className="h-3 w-3" />,
  model: <Cpu className="h-3 w-3" />,
  inference: <Sparkles className="h-3 w-3" />,
  image: <Download className="h-3 w-3" />,
};

export default function StatusBar() {
  const [isOpen, setIsOpen] = useState(false);
  const [currentTaskIndex, setCurrentTaskIndex] = useState(0);
  const { getActiveTasks } = useStatusBarStore();

  const activeTasks = getActiveTasks();
  const hasActiveTasks = activeTasks.length > 0;

  // Calculate joint progress
  const totalProgress = activeTasks.reduce((sum, task) => {
    return sum + (task.progress || 0);
  }, 0);
  const tasksWithProgress = activeTasks.filter((t) => t.progress !== undefined).length;
  const averageProgress = tasksWithProgress > 0 ? Math.round(totalProgress / tasksWithProgress) : 0;

  // Cycle through tasks when collapsed
  useEffect(() => {
    if (!isOpen && hasActiveTasks) {
      const interval = setInterval(() => {
        setCurrentTaskIndex((prev) => (prev + 1) % activeTasks.length);
      }, 3000); // Change task every 3 seconds
      return () => clearInterval(interval);
    }
  }, [isOpen, hasActiveTasks, activeTasks.length]);

  // Reset index when tasks change
  useEffect(() => {
    if (currentTaskIndex >= activeTasks.length) {
      setCurrentTaskIndex(0);
    }
  }, [activeTasks.length, currentTaskIndex]);

  // Show idle state when no active tasks
  if (!hasActiveTasks) {
    return (
      <div className="border-t">
        <div className="px-2 py-1.5">
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">No active tasks</span>
          </div>
        </div>
      </div>
    );
  }

  const currentTask = activeTasks[currentTaskIndex] || activeTasks[0];

  return (
    <div className="border-t">
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <CollapsibleTrigger className="w-full hover:bg-accent/50 transition-colors">
          {!isOpen ? (
            // Collapsed view - cycling tasks with joint progress
            <div className="px-2 py-1.5 space-y-1">
              {/* Joint progress bar - only show if we have tasks with progress */}
              {averageProgress > 0 && <Progress value={averageProgress} className="h-1" />}

              {/* Cycling task display */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 flex-1 min-w-0">
                  <Loader2 className="h-3 w-3 animate-spin text-primary shrink-0" />
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    <span className={cn('shrink-0', 'text-primary')}>{taskIcons[currentTask.type]}</span>
                    <span className="text-xs text-muted-foreground truncate">
                      {currentTask.title}: {currentTask.description}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-xs text-muted-foreground">
                    {activeTasks.length} {activeTasks.length === 1 ? 'task' : 'tasks'}
                  </span>
                  <ChevronDown className="h-3 w-3 rotate-180" />
                </div>
              </div>
            </div>
          ) : (
            // Expanded header
            <div className="px-2 py-1.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Loader2 className="h-3 w-3 animate-spin text-primary" />
                  <span className="text-xs font-medium">
                    {activeTasks.length} {activeTasks.length === 1 ? 'task' : 'tasks'} running
                  </span>
                </div>
                <ChevronDown className="h-3 w-3" />
              </div>
            </div>
          )}
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="px-2 pb-2 space-y-2 max-h-[200px] overflow-y-auto">
            {activeTasks.map((task) => (
              <div
                key={task.id}
                className={cn('rounded-md bg-muted/50 p-2 space-y-1', task.status === 'error' && 'bg-destructive/10')}
              >
                <div className="flex items-start gap-2">
                  <span
                    className={cn(
                      'mt-0.5',
                      task.status === 'active' && 'text-primary',
                      task.status === 'error' && 'text-destructive'
                    )}
                  >
                    {taskIcons[task.type]}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium truncate">{task.title}</div>
                    <div className="text-xs text-muted-foreground truncate">{task.description}</div>
                    {task.error && <div className="text-xs text-destructive truncate mt-1">Error: {task.error}</div>}
                    {task.progress !== undefined && (
                      <div className="mt-1.5">
                        <Progress value={task.progress} className="h-1" />
                        <span className="text-[10px] text-muted-foreground">{task.progress}%</span>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
