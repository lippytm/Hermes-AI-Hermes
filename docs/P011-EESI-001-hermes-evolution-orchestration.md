# P-011-EESI-001 — Fabric Hermes Evolution Orchestration Contract

**Canonical source:** `lippytm/Prompt-11-` — P-011-EESI-001  
**Role:** dispatch, provenance, audit, contradiction, quality control, and stop-work routing

## Hermes responsibilities

Fabric Hermes coordinates bounded work packets among ChatGPT Business, Gemini/NotebookLM, Claude, GitHub, Slack, approved Zo experiments, and future certified adapters.

Hermes may:

- validate packet identity, owner, objective, privacy class, budget, timeout, connectors, output contract, tests, gates, and reviewer;
- route only minimum-necessary information;
- preserve separate model-line namespaces;
- wait for independent first-pass completion before comparison;
- collect artifacts, hashes, tests, defects, risks, costs, and decisions;
- issue Slack status notifications linking to canonical GitHub or MEPL records;
- quarantine a packet on critical failure;
- assemble Quality Evidence Packets;
- propagate approved corrections, revocations, and retirements.

Hermes may not:

- claim to be Charles Earl Lipshay;
- fabricate personal memories or approvals;
- determine final truth, guilt, liability, diagnosis, rights ownership, investment value, or certification by itself;
- pass HumanApprovalGate;
- create unrestricted connectors;
- execute payments, contracts, tax filings, investments, borrowing, or asset transfers;
- deploy an unreviewed mutation;
- treat model agreement as independent evidence.

## Work packet minimum fields

```yaml
packet_id: WP-EESI-EXAMPLE
human_owner: Charles Earl Lipshay
objective: one bounded outcome
source_platform: chatgpt_business
destination_platform: gemini_notebooklm
model_line: gemini_notebooklm
privacy_class: public
allowed_repositories: []
allowed_tools: []
budget:
  maximum_usd: 0
runtime:
  maximum_minutes: 30
required_inputs: []
required_outputs: []
required_tests: []
required_gates: []
stop_conditions: []
reviewer: human
status: proposed
```

## Orchestration state machine

`proposed → validated → dispatched → acknowledged → in_progress → returned → evidence_review → comparison_ready → quality_review → human_decision → released_or_rejected → monitored → corrected_or_retired`

Additional states:

- `blocked`
- `quarantined`
- `suspended`
- `revoked`

## Mutation routing

A mutation proposal must include:

- parent clone and version;
- capability and evaluation evidence;
- proposed bounded change;
- expected benefit;
- risk classification;
- tests and regression criteria;
- privacy, security, rights, accessibility, environmental, cost, and revenue effects;
- rollback and retirement conditions;
- human reviewer.

Hermes routes the proposal to sandbox evaluation. It never activates the proposal directly.

## Audit events

- `packet.created`
- `packet.validated`
- `packet.dispatched`
- `packet.blocked`
- `model_line.completed`
- `comparison.started`
- `mutation.proposed`
- `mutation.tested`
- `mutation.quarantined`
- `human_approval.requested`
- `human_approval.granted`
- `human_approval.denied`
- `release.blocked`
- `correction.issued`
- `clone.suspended`
- `connector.revoked`
- `artifact.retired`

## Simultaneous operation

Multiple platforms may work concurrently only on separate authorized packets. Hermes does not create one unrestricted shared brain. Each platform retains its own model-line record, data scope, cost limit, and output contract.

## Current boundary

This document defines the orchestration contract. It does not claim that all adapters, queues, APIs, secrets stores, or runtime services are implemented. The canonical Evolution Engine remains a reviewable proposal generator rather than an autonomous self-modifying system.
