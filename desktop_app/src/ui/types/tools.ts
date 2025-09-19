import { type AvailableTool as Tool } from '@ui/lib/clients/archestra/api/gen';

export enum ToolCallStatus {
  Pending = 'pending',
  Executing = 'executing',
  Completed = 'completed',
  Error = 'error',
}

export { Tool };
