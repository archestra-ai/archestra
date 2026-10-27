export function comparisonProfile(mode = "primary") {
  if (!["primary", "sensitivity"].includes(mode))
    throw new Error("Unknown comparison mode");
  const sensitivity = mode === "sensitivity";
  const profile = {
    mode,
    targets: ["archestra", "litellm-default"],
    requests: sensitivity ? 5000 : 10000,
    streamRequests: sensitivity ? 1000 : 3000,
    warmup: 200,
    repeats: sensitivity ? 2 : 4,
    databaseMemoryGiB: sensitivity ? 8 : 2,
    freshDatabasePerRun: sensitivity,
    output: `benchmarks/results/cross-proxy${sensitivity ? "-sensitivity" : ""}`,
  };
  return {
    ...profile,
    successfulRowsPerRun:
      1 + profile.warmup * 2 + profile.requests + profile.streamRequests,
  };
}
