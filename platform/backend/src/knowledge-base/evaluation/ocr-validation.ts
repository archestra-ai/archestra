export function ocrOutputContainsExpected(params: {
  output: string;
  expected: string;
}): boolean {
  const expected = normalizeOcrText(params.expected);
  return Boolean(
    expected && normalizeOcrText(params.output).includes(expected),
  );
}

function normalizeOcrText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}
