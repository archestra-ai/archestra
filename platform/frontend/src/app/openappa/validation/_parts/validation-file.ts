export function exportValidationFile(file: { path: string; content: string }) {
  const url = URL.createObjectURL(
    new Blob([file.content], { type: "text/plain;charset=utf-8" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = file.path.split("/").pop() ?? "scenario.appa";
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
