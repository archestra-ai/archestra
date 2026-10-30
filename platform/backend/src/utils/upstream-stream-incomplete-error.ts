/** A provider stream closed without its required terminal event. */
export class UpstreamStreamIncompleteError extends Error {
  readonly status = 502;
}
