# P-011-CRM-EVO-002 — Fabric Hermes Quality Telemetry and Mission Compiler

Fabric Hermes is the bounded orchestration, correlation, audit, quarantine, and correction layer for canonical Prompt #11 module `P-011-CRM-EVO-002`.

## Input contract

Every relationship or quality signal must include stable signal and correlation IDs, source object, event type, privacy class, evidence reference, RiskGate, owner, required gates, and exact requested outcome.

## Mission compilation

Hermes may convert signals into review-only missions for:

- consent and suppression;
- identity and duplicate review;
- customer and learner success;
- quality and correction;
- provider certification;
- social correction propagation;
- environmental methodology;
- revenue attribution review;
- Fable 5 learning products;
- release-gate evidence.

Each mission must define assigned swarm, permitted data, tool allowlist, provider, budget, timeout, expected outputs, tests, blockers, rollback, revocation, correction, and HumanApproval state.

## Prohibitions

Hermes cannot contact real people without authorized purpose and consent, change consent, merge identities, broaden permissions, move money, execute contracts, publish, decide final truth alone, approve its own mutation, or pass HumanApprovalGate.

## State machine

`received → validated → blocked_or_routed → in_review → evidence_collected → changes_requested → human_decision → completed_or_rejected → monitored → corrected_or_retired`

Critical identity, privacy, security, provider, financial, correction, or approval failures cause quarantine or stop-work.

## Audit events

Record correlation ID, actor, source, mission, model line, provider, data class, tool use, test result, defect, cost, gate result, human decision, correction, rollback, and retirement.

This mirror defines orchestration behavior. It does not claim a live autonomous Hermes runtime.