const TERMINAL_MEMBER_STATES = new Set(["STOPPED", "DELETED"]);

export function readPath(object, path) {
  return path.split(".").reduce((value, key) => value?.[key], object);
}

function isPresent(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "string") return value.trim() !== "";
  return value !== undefined && value !== null;
}

export function evaluateQualification(profile, policy) {
  const blockers = [];
  const missingFields = [];
  const unevidencedFields = [];

  if (!profile?.id) blockers.push("missing_profile_id");
  if (!profile?.inboundEstablishedAt) blockers.push("no_inbound_relationship");
  if (TERMINAL_MEMBER_STATES.has(profile?.state)) {
    blockers.push(`member_${profile.state.toLowerCase()}`);
  } else if (
    Array.isArray(policy.allowedStates) &&
    !policy.allowedStates.includes(profile?.state)
  ) {
    blockers.push("member_state_not_allowed");
  }

  for (const path of policy.requiredFields) {
    if (!isPresent(readPath(profile, path))) {
      missingFields.push(path);
      continue;
    }
    const evidence = profile.evidenceByField?.[path];
    if (!Array.isArray(evidence) || evidence.length === 0) {
      unevidencedFields.push(path);
    }
  }

  return Object.freeze({
    policyId: policy.id,
    policyVersion: policy.version,
    qualified:
      blockers.length === 0 &&
      missingFields.length === 0 &&
      unevidencedFields.length === 0,
    blockers: Object.freeze(blockers),
    missingFields: Object.freeze(missingFields),
    unevidencedFields: Object.freeze(unevidencedFields),
  });
}

export function missingInterviewFields(qualification) {
  return Object.freeze([
    ...qualification.missingFields,
    ...qualification.unevidencedFields,
  ].slice(0, 2));
}
