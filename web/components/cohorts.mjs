/* Presentation metadata for the two founding cohorts.
 * The cohort IDS live in src/waitlist/capacity.js — this file only carries how
 * they are described to a reader, keyed by the snapshot's own property names so
 * a component can render straight from a capacity response. */
export { COHORTS } from "../../src/waitlist/capacity.js";

export const COHORT_META = Object.freeze({
  foundersDevelopers: {
    label: "Developers & founders",
    blurb: "You build. You are raising, hiring into a team, or open to the right room.",
  },
  investorsEmployers: {
    label: "Investors, employers & acquirers",
    blurb: "You deploy capital, hire, or acquire. You want fit, not volume.",
  },
});
