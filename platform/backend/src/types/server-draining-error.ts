import { ApiError } from "@archestra/shared/types";

/** An intentional refusal of new requests during graceful shutdown. */
export class ServerDrainingError extends ApiError {
  constructor() {
    super(503, "Server is shutting down");
    this.name = "ServerDrainingError";
  }
}
