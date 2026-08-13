export const COHORTS = Object.freeze({
  FOUNDER_DEVELOPER: "founder_developer",
  INVESTOR_EMPLOYER: "investor_employer",
});

export const COHORT_LIMIT = 5_000;

export const COUNTED_SUBSCRIBER_STATES = Object.freeze(
  new Set(["waiting", "qualified", "active"]),
);

export function assertCohort(value) {
  if (!Object.values(COHORTS).includes(value)) {
    throw new TypeError(`Unknown founding-network cohort: ${value}`);
  }
  return value;
}

export function buildCapacitySnapshot(records, { sequence = null, updatedAt = null } = {}) {
  const joined = {
    [COHORTS.FOUNDER_DEVELOPER]: 0,
    [COHORTS.INVESTOR_EMPLOYER]: 0,
  };

  for (const record of records) {
    if (!COUNTED_SUBSCRIBER_STATES.has(record.status)) continue;
    if (record.cohort in joined) joined[record.cohort] += 1;
  }

  const cohort = (key) => ({
    limit: COHORT_LIMIT,
    joined: joined[key],
    remaining: Math.max(0, COHORT_LIMIT - joined[key]),
    full: joined[key] >= COHORT_LIMIT,
  });

  const foundersDevelopers = cohort(COHORTS.FOUNDER_DEVELOPER);
  const investorsEmployers = cohort(COHORTS.INVESTOR_EMPLOYER);

  return Object.freeze({
    schemaVersion: 1,
    updatedAt,
    sequence,
    total: Object.freeze({
      limit: COHORT_LIMIT * 2,
      joined: foundersDevelopers.joined + investorsEmployers.joined,
      remaining: foundersDevelopers.remaining + investorsEmployers.remaining,
    }),
    cohorts: Object.freeze({
      foundersDevelopers: Object.freeze(foundersDevelopers),
      investorsEmployers: Object.freeze(investorsEmployers),
    }),
  });
}
