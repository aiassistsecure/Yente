export const member = {
  id: "bob",
  inboundEstablishedAt: "2026-08-12T12:00:00.000Z",
  state: "ACTIVE",
  professional: {
    roles: ["technical_operator"],
    capabilities: ["infrastructure_operations", "scaling_teams"],
    industries: ["b2b_saas"],
    geographies: ["us_remote"],
  },
  intent: {
    offers: ["infrastructure_leadership"],
    seeks: ["operating_role"],
    introductionTypes: ["employer"],
  },
  evidenceByField: {
    "professional.roles": ["fact_bob_role"],
    "professional.capabilities": ["fact_bob_capability"],
    "professional.industries": ["fact_bob_industry"],
    "professional.geographies": ["fact_bob_geo"],
    "intent.seeks": ["fact_bob_seek"],
    "intent.introductionTypes": ["fact_bob_intro_type"],
  },
};

export const opportunity = {
  id: "alice-employer",
  inboundEstablishedAt: "2026-08-12T12:05:00.000Z",
  state: "ACTIVE",
  types: ["employer"],
  needs: {
    requiredCapabilities: ["infrastructure_operations"],
    industries: ["b2b_saas"],
    geographies: ["us_remote"],
  },
  offers: ["operating_role"],
  evidenceByField: {
    types: ["fact_alice_type"],
    "needs.requiredCapabilities": ["fact_alice_capability"],
    "needs.industries": ["fact_alice_industry"],
    "needs.geographies": ["fact_alice_geo"],
    offers: ["fact_alice_offer"],
  },
};

export const memberQualificationPolicy = {
  id: "employer-member-qualification",
  version: "1",
  allowedStates: ["ACTIVE"],
  requiredFields: [
    "professional.roles",
    "professional.capabilities",
    "professional.industries",
    "professional.geographies",
    "intent.seeks",
    "intent.introductionTypes",
  ],
};

export const opportunityQualificationPolicy = {
  id: "employer-opportunity-qualification",
  version: "1",
  allowedStates: ["ACTIVE"],
  requiredFields: [
    "types",
    "needs.requiredCapabilities",
    "needs.industries",
    "needs.geographies",
    "offers",
  ],
};

export const matchPolicy = {
  id: "member-employer",
  version: "1",
  hardGates: [
    {
      id: "counterpart_type",
      memberPath: "intent.introductionTypes",
      opportunityPath: "types",
      operator: "overlap",
    },
    {
      id: "geography",
      memberPath: "professional.geographies",
      opportunityPath: "needs.geographies",
      operator: "overlap",
    },
  ],
  scores: {
    member: [
      {
        id: "desired_opportunity",
        memberPath: "intent.seeks",
        opportunityPath: "offers",
        operator: "overlap",
        weight: 60,
      },
      {
        id: "industry_relevance",
        memberPath: "professional.industries",
        opportunityPath: "needs.industries",
        operator: "overlap",
        weight: 40,
      },
    ],
    opportunity: [
      {
        id: "required_capability",
        memberPath: "professional.capabilities",
        opportunityPath: "needs.requiredCapabilities",
        operator: "overlap",
        weight: 60,
      },
      {
        id: "industry_experience",
        memberPath: "professional.industries",
        opportunityPath: "needs.industries",
        operator: "overlap",
        weight: 40,
      },
    ],
  },
  thresholds: { member: 60, opportunity: 60 },
};

export const frozenMatch = {
  id: "match_001",
  memberIds: ["bob", "alice"],
  reason:
    "Bob's evidenced infrastructure operations background aligns with Alice's need for B2B SaaS infrastructure leadership.",
  discussionTopic:
    "the infrastructure challenges Alice's company is solving and the operating leadership Bob can provide",
  factsUsed: [
    "fact_alice_capability",
    "fact_bob_capability",
    "fact_bob_industry",
  ],
  vetoDeadlineAt: "2026-08-14T12:00:00.000Z",
  disclosures: {
    bob: {
      displayName: "Bob",
      summary:
        "Bob is a technical operator with evidenced experience in infrastructure operations and scaling teams.",
    },
    alice: {
      displayName: "Alice",
      summary:
        "Alice represents a B2B SaaS employer seeking experienced infrastructure leadership.",
    },
  },
};
