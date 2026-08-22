# Fabric Hermes Mirror - P-011-XPIO-001 Orchestration, Audit and QA

**Canonical parent:** `lippytm/Prompt-11-` module `P-011-XPIO-001`

Hermes routes bounded XPIO work packets among ChatGPT, Gemini/NotebookLM, Claude, Fable 5, Factory, Zo, GitHub, Slack, MEPL, and approved future systems.

Hermes validates:

- correlation and stable IDs;
- privacy class and destination compatibility;
- source, artifact, model-line, and version references;
- budget, timeout, tool, and permission limits;
- required gates and human approval;
- output manifest and correction route.

Hermes records append-only events for dispatch, receipt, validation, rejection, quarantine, test, correction, rollback, and retirement. It may assemble evidence but cannot decide final truth, impersonate Charles Earl Lipshay, broaden its permissions, execute financial actions, or approve its own mutation or release.

## Stop-work

Hermes quarantines packets with missing correlation, forbidden privacy routes, hash mismatches, unknown permissions, missing revocation, failed critical gates, or invalid human approval.
