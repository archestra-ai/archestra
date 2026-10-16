export function getHttpInstrumentationConfig(params: {
  enabled: boolean;
  errorTrackingEnabled: boolean;
}) {
  return {
    enabled: params.enabled,
    // The filtered request tracer already owns inbound server spans.
    disableIncomingRequestInstrumentation: params.errorTrackingEnabled,
  };
}
