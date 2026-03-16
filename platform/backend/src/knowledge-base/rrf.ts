function reciprocalRankFusion<T>(params: {
  rankings: T[][];
  idExtractor: (item: T) => string;
  k?: number;
  weights?: number[];
}): T[] {
  const { rankings, idExtractor, k = 50, weights } = params;

  const scores = new Map<string, number>();
  const bestItem = new Map<string, { item: T; bestRank: number }>();

  for (let listIdx = 0; listIdx < rankings.length; listIdx++) {
    const ranking = rankings[listIdx];
    const weight = weights?.[listIdx] ?? 1;
    for (let i = 0; i < ranking.length; i++) {
      const item = ranking[i];
      const id = idExtractor(item);
      const rank = i + 1;
      const score = weight / (k + rank);

      scores.set(id, (scores.get(id) ?? 0) + score);

      const existing = bestItem.get(id);
      if (!existing || rank < existing.bestRank) {
        bestItem.set(id, { item, bestRank: rank });
      }
    }
  }

  return [...scores.entries()]
    .sort((a, b) => {
      const scoreDiff = b[1] - a[1];
      if (scoreDiff !== 0) return scoreDiff;
      // Tiebreak: lower best rank wins
      return (
        (bestItem.get(a[0])?.bestRank ?? Infinity) -
        (bestItem.get(b[0])?.bestRank ?? Infinity)
      );
    })
    .map(([id]) => bestItem.get(id)?.item)
    .filter((item): item is T => item !== undefined);
}

export default reciprocalRankFusion;
