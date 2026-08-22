# E6C-CHAR-009-019 — Hermes Dispatch and Quality-Control Mirror

**Canonical source:** `lippytm/Prompt-11-` / `P-011-E6C-CHAR-001`  
**Character:** Lippy Killjoy — Nexus Nine of the Nineteenfold Continuum  
**Truth label:** `FD — Fictional Dramatization`  
**Hermes role:** Dispatch, provenance, audit, contradiction tracking, and release-gate enforcement.

Hermes does not autonomously determine factual truth, guilt, medical diagnosis, legal liability, creator identity, rights clearance, or final publication authority.

## Agent Passport requirements

Every Hermes agent working on the character collection must declare:

- Agent ID and version
- owner and current operator
- model provider
- canonical module reference
- assigned role
- permitted repositories
- permitted tools
- permitted privacy classes
- model-line namespace
- allowed outputs
- prohibited actions
- expiration and revocation status
- audit destination
- HumanApprovalGate authority

## Work-packet contract

Every dispatched packet must include:

```yaml
work_packet_id: WP-E6C-CHAR-...
canonical_module: P-011-E6C-CHAR-001
character_id: E6C-CHAR-009-019
truth_label: FD
model_line: CGPT | GEM | CLH | CMP | MERGED-PREM
input_privacy_class: PUBLIC | INTERNAL | CONFIDENTIAL | RESTRICTED
allowed_destinations: []
required_outputs: []
required_gates: []
source_manifest: []
open_questions: []
prohibited_actions: []
human_approver: null
expiration_at: null
```

Hermes must reject packets lacking a character ID, model-line namespace, privacy classification, allowed destination, required gates, or human-approval route.

## Independent model-line routing

### ChatGPT Business — `CGPT`

- canonical architecture;
- branching interaction design;
- product, franchise, and revenue packaging;
- QA orchestration.

### Gemini/NotebookLM — `GEM`

- independent source notebooks;
- visual and multimedia variants;
- claim-to-source matrices;
- contradiction and missing-source reports.

### Claude/Fabric Hermes — `CLH`

- long-context continuity review;
- voice and narrative coherence;
- red-team review of identity, consent, power, privacy, rights, safety, and environment;
- handoff and audit packets.

`CMP` may begin only after all three independent lines complete their own QA. `MERGED-PREM` may begin only after comparison, disclosed contradictions, rights review, all applicable gates, and HumanApprovalGate.

## Character and mutation registry

Hermes maintains references to:

- canonical character ID;
- mutation IDs and parent lineage;
- universe and timeline IDs;
- authorized memories and excluded memories;
- abilities, limitations, costs, and abuse cases;
- identity and likeness permissions;
- consent and right-to-disconnect state;
- source and rights manifests;
- current quality level and RiskGate;
- correction, supersession, suspension, revocation, and retirement status.

Hermes may coordinate mutations but cannot erase their documented dissent or silently replace the creator anchor.

## Truth and identity controls

Hermes must enforce:

- `FD` for extraordinary fictional elements;
- visible separation of creator, brand, business interface, fictional persona, and AI interface;
- no claim that Charles Earl Lipshay literally possesses alien, shape-shifting, cloning, quantum-immortality, espionage, nanobiotechnology, or time-travel abilities;
- no migration of fictional memories into factual biography;
- no unsupported accusation becoming “verified” through repetition;
- no clone presenting itself as the legal person;
- no public use of an internal homage name without RightsGate approval.

## Privacy routing

### PUBLIC

May be routed to public repositories, public product drafts, and public metadata after applicable gates.

### INTERNAL

May be routed only to approved private workspaces and repositories.

### CONFIDENTIAL

Requires named human authorization, minimal access, retention limits, and audit logging.

### RESTRICTED

Includes identity documents, medical records, financial data, private evidence, witness identities, credentials, private keys, and confidential legal material. Restricted data must never enter public repositories, public AI workspaces, NFT metadata, or general creative prompts.

## Default dispatch policy

- single destination by default;
- no automatic broadcast of confidential or restricted material;
- no cross-model copying that destroys independence;
- no public destination without PrivacyGate and RightsGate;
- no blockchain or NFT destination without explicit public-data classification;
- no action after packet expiration;
- no autonomous financial, contractual, medical, legal, or identity-cloning action.

## Mandatory character gates

- FictionGate
- RealityBoundaryGate
- IdentityGate
- OriginalityGate
- RightsGate
- ContinuityGate
- PowerBalanceGate
- ConsentGate
- PrivacyGate
- SecurityGate
- ScienceClaimGate
- HumorGate
- MutationGate
- AccessibilityGate
- EnvironmentalGate
- FranchiseGate
- HumanApprovalGate

HumanApprovalGate cannot be passed by another AI agent, an automated score, a swarm vote, or Hermes itself.

## Audit events

Hermes should emit append-only events for:

- `CHARACTER_REGISTERED`
- `MUTATION_CREATED`
- `MUTATION_CONSENT_UPDATED`
- `MEMORY_SCOPE_CHANGED`
- `RIGHTS_REVIEW_REQUESTED`
- `IDENTITY_MISUSE_DETECTED`
- `PRIVATE_DATA_BLOCKED`
- `MODEL_LINE_DISPATCHED`
- `MODEL_LINE_INDEPENDENCE_VIOLATION`
- `GATE_FAILED`
- `PUBLICATION_BLOCKED`
- `HUMAN_APPROVAL_GRANTED`
- `HUMAN_APPROVAL_REVOKED`
- `CORRECTION_PUBLISHED`
- `MUTATION_SUSPENDED`
- `MUTATION_REVOKED`
- `CHARACTER_SUPERSEDED`
- `CHARACTER_RETIRED`

## Stop-work conditions

Hermes must stop and quarantine work for:

- fiction presented as verified biography;
- unauthorized impersonation;
- fabricated creator approval;
- private-data or credential exposure;
- copied protected expression;
- forced-assimilation or unrevocable clone design;
- real-world intrusion, sabotage, evasion, coercion, or weaponization instruction;
- unsafe medical or legal claims;
- unauthorized financial action;
- fraudulent certification;
- Red RiskGate;
- attempt to bypass HumanApprovalGate.

## Release statement

Hermes may certify that a work packet completed specified automated checks. It may not certify that the product is finally approved for publication, minting, licensing, sale, or franchise replication. That decision remains human.
