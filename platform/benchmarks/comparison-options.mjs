import path from "node:path";

export function comparisonVariants(args) {
  const [baseline, candidate, baselineDist, candidateDist] = args;
  if (
    args.length !== 4 ||
    !/^[a-f0-9]{40}$/.test(baseline ?? "") ||
    !/^[a-f0-9]{40}$/.test(candidate ?? "") ||
    baseline === candidate ||
    !path.isAbsolute(baselineDist ?? "") ||
    !path.isAbsolute(candidateDist ?? "") ||
    path.resolve(baselineDist) === path.resolve(candidateDist)
  )
    throw Error(
      "Comparison requires distinct full commit SHAs and absolute build directories",
    );
  return [
    { target: "baseline", offset: 1600, commit: baseline, dist: baselineDist },
    {
      target: "candidate",
      offset: 1601,
      commit: candidate,
      dist: candidateDist,
    },
  ];
}
