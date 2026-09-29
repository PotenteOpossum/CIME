const TRAITS = ['O', 'C', 'E', 'A', 'N'];

// A conservative synthetic prior, not population norms or questionnaire scores.
// Reject tails instead of clamping them, which would pile up values at the limits.
function sampleTrait(random) {
  let value;
  do {
    const normal = Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());
    value = 0.5 + 0.18 * normal;
  } while (value < 0.15 || value > 0.85);
  return Math.round(value * 20) / 20;
}

export function randomizeActiveOcean(personas, participantUsers, random = Math.random) {
  const next = { ...personas };
  for (const user of participantUsers) {
    const persona = personas[user.id];
    if (user.is_admin || !persona?.active) continue;
    next[user.id] = {
      ...persona,
      ocean: Object.fromEntries(TRAITS.map((trait) => [trait, sampleTrait(random)]))
    };
  }
  return next;
}
