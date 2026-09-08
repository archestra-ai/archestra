const [tool, ...args] = process.argv.slice(2);
const response = await fetch(`${process.env.RELEASE_HARNESS_URL}/tool`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ tool, args }),
});
const body = await response.json();
if (!response.ok) {
  process.stderr.write(`${body.error}\n`);
  process.exit(1);
}
process.stdout.write(`${JSON.stringify(body)}\n`);
