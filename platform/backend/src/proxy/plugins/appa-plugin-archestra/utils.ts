export function readHeader(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  name: string,
): string | undefined {
  const normalizedName = name.toLowerCase();
  const value =
    headers[normalizedName] ??
    Object.entries(headers).find(
      ([headerName]) => headerName.toLowerCase() === normalizedName,
    )?.[1];
  return Array.isArray(value) ? value[0] : value;
}
