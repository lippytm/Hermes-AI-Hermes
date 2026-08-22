# P-011-CRM-001 — Fabric Hermes CRM Orchestration

**Canonical source:** `lippytm/Prompt-11-`  
**Status:** Q2 architecture mirror

## Mission

Fabric Hermes routes bounded CRM work while preserving identity, consent, source provenance, privacy, model-line independence, quality evidence, deadlines, corrections, and human authority.

## CRM Work Packet validation

Before dispatch, Hermes validates:

- stable work-packet and correlation IDs;
- human owner and reviewer;
- party role and lawful purpose;
- minimum-necessary data and privacy class;
- consent and suppression state;
- model-line identity;
- permitted tools and destinations;
- budget, timeout, and rate limit;
- source, artifact, and decision references;
- required gates and correction route;
- actions requiring human approval.

Invalid, ambiguous, over-permissioned, or consent-deficient packets are rejected or quarantined.

## Bounded CRM mission types

- intake and consent review;
- identity and duplicate review;
- customer or learner journey follow-up;
- learner-success and support review;
- service-level escalation;
- affiliate, mentor, partner, and franchise coordination;
- campaign and attribution analysis;
- data-quality and freshness remediation;
- privacy-rights, correction, deletion, and retirement;
- social-content and provider-adapter review.

## Prohibited Hermes actions

Hermes cannot:

- contact a real party without an approved channel and consent state;
- grant or withdraw another person’s consent;
- merge legal identities or fictional characters automatically;
- determine final truth, guilt, diagnosis, liability, or eligibility alone;
- approve refunds, prices, contracts, payments, investments, or asset transfers;
- broaden connector permissions;
- pass HumanApprovalGate or approve its own mutation.

## State machines

### Work packet

`captured → validated → routed → in_progress → review → quality_review → human_decision → completed → monitored → corrected_or_retired`

Additional states: `rejected`, `blocked`, `quarantined`, `revoked`.

### CRM mission

`proposed → review → authorized → dispatched → evidence_returned → QA → human_decision → completed_or_corrected`

## Audit events

Hermes records dispatch, rejection, quarantine, acceptance, tool use, result, test, gate, escalation, approval request, correction, rollback, revocation, retirement, and archive events. Each event includes actor, model line, work packet, correlation ID, object, result, evidence reference, privacy class, and human-approval state.

## Stop-work triggers

- missing or withdrawn consent;
- suppression conflict;
- identity ambiguity with risk of wrongful merge;
- restricted data routed to an unauthorized platform;
- unknown connector permissions or no revocation method;
- deceptive communication or unsupported outcome claim;
- financial-authority attempt;
- critical gate failure or Red RiskGate;
- cost or timeout breach.

## Current boundary

This mirror defines orchestration and audit rules. It does not claim a production Hermes runtime or live synchronization across HubSpot, Airtable, social platforms, ManyChat, Zo, or future systems.
