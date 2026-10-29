export function benchmarkPorts(value = "0") {
  if (!/^\d{1,4}$/.test(String(value)))
    throw new Error("Benchmark port offset must be an integer from 0 to 9999");
  const offset = Number(value);
  return {
    backend: 19000 + offset,
    metrics: 19050 + offset,
    mock: 19092 + offset,
    postgres: 15432 + offset,
  };
}
