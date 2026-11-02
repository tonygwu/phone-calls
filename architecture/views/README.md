# Private telephone assistant

Historical architecture snapshot. These views predate removal of readiness checks, budgets, and duplicate-request controls, and omit later conference features.
Use [the current operations guide](../../docs/OPERATIONS.md) for runtime behavior.

Deployed private Cloudflare calling service, connected primary clients, and evaluated provider agent. Ordinary destination rollout is tracked separately.

Start with the overview, then choose the question you want to explore.

## 1. How one authorized call reaches an outcome

What does the owner receive?

The client first awaits provider checks of configuration, routing, credits, rates and funding. The coordinator then persists a pending call and alarm and returns an ID. A later alarm dials once. The three primary clients have authenticated. Additional Claude profiles need separate sign-in.

[Mermaid diagram](sources/overview.mmd) · [FigJam source](sources/overview.figjam.mmd) · [D2](sources/overview.d2)

[Data examples and table schemas](data/overview.html) · [Native canvas card text](data/overview.json)

The diagrams use color and shape for component roles; status words identify what exists or is planned.

[Agent session panels](agents/overview.html) · [Native session text](agents/overview.json)

- **MCP client** (Client application; existing): Primary Codex, ChatGPT and Claude Code submit authorized briefs and retrieve results. Three additional Claude profiles still need login.
- **Authenticated Worker** (Worker - processes assigned work; existing): Checks owner identity and provider signatures.
- **Durable call coordinator** (Program step - fixed rules; existing): Admits one call, reserves budget and reconciles evidence.
- **SQLite storage** (Saved data; existing): Persists tasks before dialing and deletes content after 30 days.
- **Cloudflare Access login** (External software or service; existing): Supplies a signed owner assertion after OAuth login.
- **Twilio telephone connection** (External software or service; existing): Provides the dedicated number, call status and forced hangup.
- **ElevenLabs telephone agent** (Agent - chooses its next action; existing): Uses supplied facts and authority to conduct one conversation; behavior requires checking against evidence.

## 2. How calls survive disconnects

How are redials, overruns and retained private content prevented?

Saved dispatch state prevents redial. Active-call checks take priority over old analysis or billing work; termination requests can repeat until confirmed. Ordered provider observations cannot regress final results. At 30 days content expires and unresolved calls leave a content-free block.

[Mermaid diagram](sources/recovery.mmd) · [FigJam source](sources/recovery.figjam.mmd) · [D2](sources/recovery.d2)

[Data examples and table schemas](data/recovery.html) · [Native canvas card text](data/recovery.json)

The diagrams use color and shape for component roles; status words identify what exists or is planned.

[Agent session panels](agents/recovery.html) · [Native session text](agents/recovery.json)

- **Durable call coordinator** (Program step - fixed rules; existing): Admits one call, reserves budget and reconciles evidence.
- **SQLite storage** (Saved data; existing): Persists tasks before dialing and deletes content after 30 days.
- **Persistent watchdog** (Schedule - starts work at a set time; existing): Resumes work, enforces deadlines and purges expired content.
- **Twilio telephone connection** (External software or service; existing): Provides the dedicated number, call status and forced hangup.
- **ElevenLabs telephone agent** (Agent - chooses its next action; existing): Uses supplied facts and authority to conduct one conversation; behavior requires checking against evidence.

## 3. What one telephone conversation can know and do

What can the voice agent do?

A fresh brief supplies facts and authority. The configured model can wait, select menu digits, handle voicemail and hang up. Corrected text examples and one real voicemail were accepted; physical keypad delivery and acoustic hold timing remain unverified.

[Mermaid diagram](sources/agent-session.mmd) · [FigJam source](sources/agent-session.figjam.mmd) · [D2](sources/agent-session.d2)

[Data examples and table schemas](data/agent-session.html) · [Native canvas card text](data/agent-session.json)

The diagrams use color and shape for component roles; status words identify what exists or is planned.

[Agent session panels](agents/agent-session.html) · [Native session text](agents/agent-session.json)

- **ElevenLabs telephone agent** (Agent - chooses its next action; existing): Uses supplied facts and authority to conduct one conversation; behavior requires checking against evidence.

