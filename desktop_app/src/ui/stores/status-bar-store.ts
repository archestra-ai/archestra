import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

import websocketService from '@ui/lib/websocket';

export interface StatusTask {
  id: string;
  type: 'runtime' | 'server' | 'download' | 'model' | 'inference' | 'image' | 'analysis';
  title: string;
  description: string;
  progress?: number;
  status: 'pending' | 'active' | 'completed' | 'error';
  timestamp: number;
  error?: string;
}

interface StatusBarState {
  tasks: Map<string, StatusTask>;
  activeInferenceId: string | null;
  addTask: (task: StatusTask) => void;
  updateTask: (id: string, updates: Partial<StatusTask>) => void;
  removeTask: (id: string) => void;
  clearCompletedTasks: () => void;
  getActiveTasks: () => StatusTask[];
  setChatInference: (chatId: string | null, title?: string, isActive?: boolean) => void;
}

export const useStatusBarStore = create<StatusBarState>()(
  subscribeWithSelector((set, get) => ({
    tasks: new Map(),
    activeInferenceId: null,

    addTask: (task) => {
      set((state) => {
        const newTasks = new Map(state.tasks);
        newTasks.set(task.id, task);
        return { tasks: newTasks };
      });
    },

    updateTask: (id, updates) => {
      set((state) => {
        const newTasks = new Map(state.tasks);
        const existingTask = newTasks.get(id);
        if (existingTask) {
          newTasks.set(id, { ...existingTask, ...updates, timestamp: Date.now() });
        } else {
          // If task doesn't exist, create it
          newTasks.set(id, { id, ...updates, timestamp: Date.now() } as StatusTask);
        }
        return { tasks: newTasks };
      });
    },

    removeTask: (id) => {
      set((state) => {
        const newTasks = new Map(state.tasks);
        newTasks.delete(id);
        return { tasks: newTasks };
      });
    },

    clearCompletedTasks: () => {
      set((state) => {
        const newTasks = new Map(state.tasks);
        for (const [id, task] of newTasks) {
          if (task.status === 'completed') {
            newTasks.delete(id);
          }
        }
        return { tasks: newTasks };
      });
    },

    getActiveTasks: () => {
      const tasks = Array.from(get().tasks.values());
      return tasks
        .filter((task) => task.status === 'active' || task.status === 'pending')
        .sort((a, b) => {
          // Priority: runtime > image > server > analysis > download > model > inference
          const typePriority = { runtime: 0, image: 1, server: 2, analysis: 3, download: 4, model: 5, inference: 6 };
          const aPriority = typePriority[a.type] ?? 7;
          const bPriority = typePriority[b.type] ?? 7;
          if (aPriority !== bPriority) return aPriority - bPriority;

          // Then by status (active before pending)
          if (a.status !== b.status) {
            return a.status === 'active' ? -1 : 1;
          }

          // Then by timestamp (newer first)
          return b.timestamp - a.timestamp;
        });
    },

    setChatInference: (chatId, title, isActive = true) => {
      if (isActive && chatId) {
        // Starting inference for a chat
        const taskId = `chat-${chatId}`;
        const task = {
          id: taskId,
          type: 'inference' as const,
          title: 'Chat Generation',
          description: title || 'Generating response...',
          status: 'active' as const,
          timestamp: Date.now(),
        };
        set({ activeInferenceId: chatId });
        get().updateTask(taskId, task);
      } else if (!isActive && chatId) {
        // Stopping inference for a specific chat
        const taskId = `chat-${chatId}`;
        const task = get().tasks.get(taskId);
        if (task && get().activeInferenceId === chatId) {
          set({ activeInferenceId: null });
          get().updateTask(taskId, { status: 'completed' });
          setTimeout(() => get().removeTask(taskId), 2000);
        }
      }
    },
  }))
);

// Subscribe to WebSocket events after connection
const setupWebSocketSubscriptions = () => {
  websocketService.subscribe('sandbox-status-update', ({ payload }) => {
    const store = useStatusBarStore.getState();

    // Handle overall sandbox status
    if (payload.status) {
      const sandboxTaskId = 'sandbox-status';

      if (payload.status === 'initializing') {
        store.updateTask(sandboxTaskId, {
          id: sandboxTaskId,
          type: 'runtime',
          title: 'Sandbox',
          description: 'Initializing container runtime...',
          status: 'active',
          timestamp: Date.now(),
        });
      } else if (payload.status === 'stopping') {
        store.updateTask(sandboxTaskId, {
          id: sandboxTaskId,
          type: 'runtime',
          title: 'Sandbox',
          description: 'Stopping container runtime...',
          status: 'active',
          timestamp: Date.now(),
        });
      } else if (payload.status === 'error') {
        store.updateTask(sandboxTaskId, {
          id: sandboxTaskId,
          type: 'runtime',
          title: 'Sandbox',
          description: 'Runtime error',
          status: 'error',
          error: 'Container runtime encountered an error',
          timestamp: Date.now(),
        });
        // Keep error visible longer
        setTimeout(() => store.removeTask(sandboxTaskId), 10000);
      } else if (payload.status === 'running' || payload.status === 'stopped') {
        // Remove the overall status task when stable
        store.removeTask(sandboxTaskId);
      }
    }

    // Handle runtime status (Podman machine and image pull)
    if (payload.runtime) {
      const runtime = payload.runtime;

      // Machine startup task - separate from image pull
      if (runtime.machineStartupPercentage !== undefined) {
        const machineTaskId = 'podman-machine';

        if (runtime.machineStartupPercentage < 100) {
          store.updateTask(machineTaskId, {
            id: machineTaskId,
            type: 'runtime',
            title: 'Podman Machine',
            description: runtime.machineStartupMessage || 'Starting Podman machine...',
            progress: runtime.machineStartupPercentage,
            status: runtime.machineStartupError ? 'error' : 'active',
            error: runtime.machineStartupError || undefined,
            timestamp: Date.now(),
          });

          if (runtime.machineStartupError) {
            // Keep errors visible longer
            setTimeout(() => store.removeTask(machineTaskId), 10000);
          }
        } else {
          // Mark as completed and remove after short delay
          store.updateTask(machineTaskId, {
            status: 'completed',
            progress: 100,
            description: 'Podman machine ready',
          });
          setTimeout(() => store.removeTask(machineTaskId), 2000);
        }
      }

      // Image pull task - separate from machine startup
      if (runtime.pullPercentage !== undefined) {
        const imageTaskId = 'base-image-pull';

        if (runtime.pullPercentage < 100) {
          store.updateTask(imageTaskId, {
            id: imageTaskId,
            type: 'image',
            title: 'Container Image',
            description: runtime.pullMessage || 'Pulling base image...',
            progress: runtime.pullPercentage,
            status: runtime.pullError ? 'error' : 'active',
            error: runtime.pullError || undefined,
            timestamp: Date.now(),
          });

          if (runtime.pullError) {
            // Keep errors visible longer
            setTimeout(() => store.removeTask(imageTaskId), 10000);
          }
        } else {
          store.updateTask(imageTaskId, {
            status: 'completed',
            progress: 100,
            description: 'Base image ready',
          });
          setTimeout(() => store.removeTask(imageTaskId), 2000);
        }
      }
    }

    // Handle MCP servers with detailed container lifecycle
    if (payload.mcpServers) {
      for (const [serverId, serverData] of Object.entries(payload.mcpServers)) {
        const taskId = `mcp-${serverId}`;

        // Check container status
        if (serverData.container) {
          const container = serverData.container;

          // Map container states to user-friendly messages
          const getContainerDescription = (state: string, message: string | null) => {
            switch (state) {
              case 'created':
                return 'Container created, preparing to start...';
              case 'initializing':
                return message || 'Starting container...';
              case 'restarting':
                return 'Restarting container...';
              case 'stopping':
                return 'Stopping container...';
              case 'stopped':
              case 'exited':
                return 'Container stopped';
              case 'error':
                return message || 'Container error';
              case 'running':
                return 'Container running';
              default:
                return message || `State: ${state}`;
            }
          };

          // Determine if this state should show a task
          const shouldShowTask =
            container.state !== 'not_created' &&
            container.state !== 'running' &&
            container.state !== 'stopped' &&
            container.state !== 'exited';

          if (shouldShowTask) {
            store.updateTask(taskId, {
              id: taskId,
              type: 'server',
              title: `MCP: ${serverId}`,
              description: getContainerDescription(container.state, container.message),
              progress: container.startupPercentage,
              status: container.state === 'error' ? 'error' : 'active',
              error: container.error || undefined,
              timestamp: Date.now(),
            });

            // Keep error states visible longer
            if (container.state === 'error') {
              setTimeout(() => store.removeTask(taskId), 10000);
            }
          } else if (container.state === 'running') {
            // Server is connected, mark as completed briefly
            const existingTask = store.tasks.get(taskId);
            if (existingTask && existingTask.status === 'active') {
              store.updateTask(taskId, {
                status: 'completed',
                progress: 100,
                description: 'Connected successfully',
              });
              setTimeout(() => store.removeTask(taskId), 2000);
            }
          } else if (container.state === 'stopped' || container.state === 'exited') {
            // Remove task for stopped containers
            store.removeTask(taskId);
          }
        }
      }
    }
  });

  // Subscribe to Ollama model download events
  websocketService.subscribe('ollama-model-download-progress', ({ payload }) => {
    const store = useStatusBarStore.getState();

    if (payload.model && payload.status) {
      const taskId = `ollama-${payload.model}`;

      if (payload.status === 'downloading' || payload.status === 'verifying') {
        store.updateTask(taskId, {
          id: taskId,
          type: 'download',
          title: `Downloading ${payload.model}`,
          description: payload.message || (payload.status === 'verifying' ? 'Verifying...' : 'Downloading...'),
          progress: payload.progress,
          status: 'active',
          timestamp: Date.now(),
        });
      } else if (payload.status === 'completed') {
        store.updateTask(taskId, { status: 'completed', progress: 100 });
        setTimeout(() => store.removeTask(taskId), 2000);
      } else if (payload.status === 'error') {
        store.updateTask(taskId, {
          status: 'error',
          error: payload.message || 'Download failed',
        });
      }
    }
  });

  // Subscribe to tool analysis events
  websocketService.subscribe('tool-analysis-progress', ({ payload }) => {
    const store = useStatusBarStore.getState();

    if (payload.mcpServerId && payload.status) {
      const taskId = `tool-analysis-${payload.mcpServerId}`;

      if (payload.status === 'started' || payload.status === 'analyzing') {
        store.updateTask(taskId, {
          id: taskId,
          type: 'analysis',
          title: `Tool Analysis: ${payload.mcpServerId}`,
          description: payload.message || 'Analyzing tools...',
          progress: payload.progress || 0,
          status: 'active',
          timestamp: Date.now(),
        });
      } else if (payload.status === 'completed') {
        store.updateTask(taskId, {
          status: 'completed',
          progress: 100,
          description: payload.message || 'Analysis complete',
        });
        setTimeout(() => store.removeTask(taskId), 3000);
      } else if (payload.status === 'error') {
        store.updateTask(taskId, {
          status: 'error',
          error: payload.error || 'Analysis failed',
          description: payload.message || 'Analysis failed',
        });
        setTimeout(() => store.removeTask(taskId), 10000);
      }
    }
  });
};

// Connect and setup subscriptions
if (typeof window !== 'undefined') {
  websocketService
    .connect()
    .then(() => {
      console.log('StatusBar WebSocket connected, setting up subscriptions');
      setupWebSocketSubscriptions();
    })
    .catch(console.error);
}

// Auto-cleanup completed tasks after 10 seconds
setInterval(() => {
  const store = useStatusBarStore.getState();
  const now = Date.now();

  for (const [id, task] of store.tasks) {
    if (task.status === 'completed' && now - task.timestamp > 10000) {
      store.removeTask(id);
    }
  }
}, 5000);
