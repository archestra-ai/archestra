import { type AvailableTool as Tool } from '@ui/lib/clients/archestra/api/gen';

export enum ToolCallStatus {
  Pending = 'pending',
  AwaitingApproval = 'awaiting_approval',
  Approved = 'approved',
  Declined = 'declined',
  Executing = 'executing',
  Completed = 'completed',
  Error = 'error',
}

export { Tool };
