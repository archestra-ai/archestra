function reciprocalRankFusion<T>(params: {
  rankings: T[][];
  idExtractor: (item: T) => string;
  k?: number;
  weights?: number[];
  /**
   * Whether a lane could, in principle, have returned this item. Defaults to
   * "every lane can return everything".
   *
   * RRF treats absence from a lane as evidence against an item, which is only
   * fair when every lane ranks the same candidate universe. Some do not: the
   * keyword lane matches words, so a media chunk (a base64 data URL) can never
   * appear in it no matter how relevant it is. Counting that structural
   * absence against the chunk let a text chunk that merely placed in both
   * lanes outrank an image that was the single best semantic match — the image
   * was then cut by the post-fusion slice and never reached the caller.
   *
   * Scores are therefore averaged over the lanes an item was ELIGIBLE for
   * rather than summed over all lanes. An item eligible everywhere is
   * unaffected in ranking terms (every score is divided by the same total
   * weight), so this is a no-op wherever every lane sees every candidate.
   */
  isEligible?: (item: T, laneIndex: number) => boolean;
}): T[] {
  const { rankings, idExtractor, k = 50, weights, isEligible } = params;

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

  // Normalize each item by the weight of the lanes it could have appeared in.
  // With no eligibility rule every item divides by the same constant, leaving
  // the order identical to a plain sum.
  if (scores.size > 0) {
    for (const [id, score] of scores) {
      const item = bestItem.get(id)?.item;
      if (item === undefined) continue;
      let eligibleWeight = 0;
      for (let listIdx = 0; listIdx < rankings.length; listIdx++) {
        if (isEligible && !isEligible(item, listIdx)) continue;
        eligibleWeight += weights?.[listIdx] ?? 1;
      }
      // An item no lane could have produced still came from somewhere; leave
      // its summed score untouched rather than dividing by zero.
      if (eligibleWeight > 0) {
        scores.set(id, score / eligibleWeight);
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
