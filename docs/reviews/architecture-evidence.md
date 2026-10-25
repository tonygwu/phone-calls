# Architecture evidence audit

Two evidence corrections are required before the architecture artifacts are complete. The local implementation exists and its tests pass, but the model overstates the client connection and uses source references that do not identify real symbols.

Scope: the local Worker, durable coordinator, SQLite state, provider adapters, tests, configuration, and generated architecture cards. I read `docs/REQUEST.md`, `architecture/model.jsonl`, `architecture/REPORT.md`, the generated view guide and data/session cards, and the corresponding source and tests. No account provisioning, deployment, live call, or client connection was attempted. Task-private files and credentials were not inspected.

## Findings

### E1 — The client is marked verified without evidence of a client connection

- **Severity:** medium. **Confidence:** high.
- **Challenged record:** component `client`, and its presentation in `architecture/views/README.md:21`.
- **Evidence:** `architecture/model.jsonl:2` marks the MCP client `existing` and `verified`, citing `src/mcp.ts` symbol `createServer`. That function constructs the server and registers tools at `src/mcp.ts:5-17`. It is not a client or a connection. The local test sends synthetic HTTP requests directly to the handler at `test/mcp.test.ts:7-26`. `architecture/REPORT.md:5` explicitly says live client connections remain proposed; `docs/CLIENTS.md:18-22` treats registration and OAuth tool discovery as future acceptance steps.
- **Correction:** mark the production client and its connection proposed, with a rationale that client authorization and discovery are pending. If the model needs an existing client for the local execution path, represent the synthetic HTTP test caller separately and cite `test/mcp.test.ts:7-26`. Do not use a server factory as evidence for a client.

### E2 — Thirteen evidence references name symbols absent from the cited files

- **Severity:** medium. **Confidence:** high.
- **Challenged records:** `access`; all ten existing flow records; risks `voicemail-evidence` and `quote-refresh`.
- **Evidence:** a literal token audit found thirteen missing symbol tokens. The architecture validator still returns `valid: true`, because successful structural validation does not establish the accuracy of these source locators. In addition, `twilio` uses `configuration`, which occurs in prose but does not name the implementing class or method.
- **Correction:** use the actual symbols and line ranges below, then regenerate the view bundle. These replacements support the local implementation; they do not prove deployed resources or live behavior.

| Model record | Source locator that supports the claim |
| --- | --- |
| `access` | `scripts/provision.ts:23-28`, constant `access` and callback bypass definitions; proposed configuration only |
| `twilio` | `src/providers.ts:47-48`, `LiveProviders`; `src/providers.ts:73-81`, number/account checks; `src/providers.ts:115-124`, `call` and `terminate` |
| `request` | `test/mcp.test.ts:10-12` for the existing synthetic caller; `src/index.ts:39-42` and `src/mcp.ts:13` for the receiving path |
| `route` | `src/index.ts:15-18`, closure `invoke`; `src/ledger.ts:34`, start routing |
| `persist` | `src/engine.ts:64-71`, `dispatch`, including the write before the outbound call |
| `resume` | `src/ledger.ts:18-20`, `alarm` |
| `schedule` | `src/ledger.ts:13-16`, `schedule`; `src/ledger.ts:63`, invocation after operations |
| `start` | `src/providers.ts:100-101`, `dispatch`; `src/agent.ts:68-87`, `dispatchBody` |
| `hangup` | `src/providers.ts:115-124`, `call` and `terminate`; `src/engine.ts:114-128`, request and status confirmation |
| `callback` | `src/index.ts:20-27`, exact callback route, signature check and awaited persistence |
| `evidence` | `src/providers.ts:103-106`, `conversation`; `src/engine.ts:169-179`, `callback` authoritative read and persistence |
| `return` | `src/engine.ts:181-194`, `view`; `src/mcp.ts:8-10`, response wrapping |
| `voicemail-evidence` | `docs/EVALUATION.md:7-11`, untested mailbox delivery and owner confirmation requirement |
| `quote-refresh` | `src/providers.ts:66-69`, `preflight`; `src/engine.ts:34`, final expiry check |

## Attacked and held

- **The durable coordinator and SQLite tables are real local components.** `src/index.ts:15-18` routes to the bound Durable Object. `cloudflare.config.ts:14-16` declares SQLite-backed storage and the binding. `src/ledger.ts:9-12` constructs `SqlStore` and `CallEngine`. The four table declarations match the data cards at `src/store.ts:19-26`.
- **The persistent scheduler is wired into the implementation.** `src/ledger.ts:13-20` persists alarms and dispatches `tick`; successful operations reschedule at line 63. This supports implemented code, not proof of live Cloudflare scheduling.
- **The dispatch-before-network guarantee has source and local test evidence.** `src/engine.ts:64-71` saves the dispatch marker first. `test/engine.test.ts:29-33` checks the persisted state from inside the mocked outbound call. Tests at lines 55-64 cover ambiguous timeout and restart without redial.
- **Owner authentication and callback checks are implemented separately.** `src/index.ts:20-36` accepts only two exact signed callback paths before owner authentication. `src/auth.ts:7-15` requires the selected issuer, audience, subject and email. The local security suite covers substituted identities, alternate hosts, callback-like paths and signed bodies.
- **Remote deployment state is correctly qualified elsewhere.** The Access application, Twilio connection and ElevenLabs agent have proposed lifecycle. `architecture/REPORT.md:5` disclaims deployed identities and served-model evidence. `src/agent.ts:35-43` supports the configured model, disabled fallback and four declared tools. The session cards correctly say provider execution remains untested.
- **Retention matches the documented local policy.** `src/store.ts:56-65` deletes expired task contents while retaining request hashes, aggregate charges and a content-free unresolved-call block. Tests at `test/engine.test.ts:122-130` exercise both terminal and unresolved tasks.
- **The public result does not claim verified voicemail delivery.** `src/engine.ts:184-190` separates telephone state from task outcome and always returns `delivery_verified: false`; tests at `test/engine.test.ts:79-83` and `136-138` cover that distinction.

## Commands and actual results

Model validation:

```sh
python3 <architecture-skill>/scripts/architecture.py validate architecture/model.jsonl --source-root . --json
```

Relevant actual output:

```json
{
  "errors": [],
  "valid": true,
  "warnings": []
}
```

Evidence-token audit:

```sh
python3 - <<'PY'
import json,re
from pathlib import Path
for line in Path('architecture/model.jsonl').read_text().splitlines():
 r=json.loads(line)
 for e in r.get('evidence',[]):
  symbol=e.get('symbol')
  p=Path(e['source'])
  if symbol and not re.search(r'\b'+re.escape(symbol)+r'\b',p.read_text()):
   print(f"{r['id']}: {p}: symbol {symbol!r} absent")
PY
```

Actual output:

```text
access: scripts/provision.ts: symbol 'configuration' absent
request: src/mcp.ts: symbol 'implementation' absent
route: src/ledger.ts: symbol 'implementation' absent
persist: src/engine.ts: symbol 'implementation' absent
resume: src/ledger.ts: symbol 'implementation' absent
schedule: src/ledger.ts: symbol 'implementation' absent
start: src/providers.ts: symbol 'implementation' absent
hangup: src/providers.ts: symbol 'implementation' absent
callback: src/index.ts: symbol 'implementation' absent
evidence: src/providers.ts: symbol 'implementation' absent
return: src/engine.ts: symbol 'implementation' absent
voicemail-evidence: docs/EVALUATION.md: symbol 'limits' absent
quote-refresh: src/providers.ts: symbol 'limits' absent
```

Local tests:

```sh
npm test -- --reporter=dot
```

The first invocation could not start any tests because the sandbox prohibited a local listening socket. Actual diagnostic: `Error: listen EPERM: operation not permitted 127.0.0.1`; summary: `Test Files no tests`, `Tests no tests`, `Errors 4 errors`. This was an environment failure, not a failed assertion. The bounded local rerun with loopback permission exited 0:

```text
 Test Files  4 passed (4)
      Tests  41 passed (41)
```

Attempted tests on the runnable invocation: 41. Succeeded: 41. Failed assertions: 0. Earlier startup failures: four worker-start errors classified as sandbox networking. Live provider tests attempted: 0.

No implementation or canonical-model file was changed by this audit. The primary agent owns finding dispositions and the final regenerated artifacts.
