import { expect, test } from "vitest";
import OpenAppaPolicyFileModel from "@/models/openappa-policy-file";

test("reads the hashes alone, and the bytes of the named documents across lookup chunks", async () => {
  const documents = Array.from(
    { length: 501 },
    (_, index) => `[policy]\nversion = 2\n# opening ${index}\n`,
  );
  const hashes: string[] = [];
  for (const document of documents)
    hashes.push(await OpenAppaPolicyFileModel.store(document));

  expect((await OpenAppaPolicyFileModel.listHashes()).sort()).toEqual(
    [...hashes].sort(),
  );
  const found = await OpenAppaPolicyFileModel.findByHashes([
    ...hashes,
    "0".repeat(64),
  ]);
  expect(
    new Map(
      found.map(({ hash, bytes }) => [
        hash,
        Buffer.from(bytes).toString("utf8"),
      ]),
    ),
  ).toEqual(new Map(hashes.map((hash, index) => [hash, documents[index]])));
});
