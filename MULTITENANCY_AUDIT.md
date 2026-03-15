# OpenClaw Multi-Tenancy Audit for VeloKai Integration

> **Audit scope**: Assess OpenClaw's readiness to serve as VeloKai's agent execution layer in a multi-tenant SaaS architecture (10,000+ tenants, hard isolation, ephemeral containers).
>
> **No code changes included** — this document identifies gaps, risks, and a phased remediation plan.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Architecture Context](#2-architecture-context)
3. [Critical Blockers (Must Fix)](#3-critical-blockers-must-fix)
4. [High-Risk Gaps (Should Fix)](#4-high-risk-gaps-should-fix)
5. [Medium-Risk Concerns](#5-medium-risk-concerns)
6. [What Already Works](#6-what-already-works)
7. [Recommended Architecture](#7-recommended-architecture)
8. [Phased Remediation Plan](#8-phased-remediation-plan)
9. [Cost & Complexity Estimates](#9-cost--complexity-estimates)
10. [Cross-Tenant Data Leak Vectors](#10-deep-dive-cross-tenant-data-leak-vectors)
11. [Files Requiring Modification (If Forking)](#11-files-requiring-modification-if-forking)
12. [Per-Tenant Dynamic Configuration via Modal](#12-per-tenant-dynamic-configuration-via-modal)

---

## 1. Executive Summary

**Verdict: OpenClaw is architecturally viable as VeloKai's execution layer, but NOT in its current form as a shared multi-tenant gateway.**

The only viable path for 10,000+ tenants with hard isolation is **ephemeral, per-request container execution** — spin up an isolated OpenClaw container per webhook event, execute the agent, return results, destroy the container.

OpenClaw already has strong foundations for this:
- The `/hooks/agent` endpoint (with SaaS trust model documentation built-in)
- Docker containerization with non-root, health checks, and minimal attack surface
- Session key namespacing support (`saas:<tenantId>:<sessionId>`)
- Per-request agent isolation (each hook creates its own agent run)

**However, 6 critical blockers prevent production multi-tenant use today.**

---

## 2. Architecture Context

### VeloKai → OpenClaw Data Flow
```
VeloKai Customer         VeloKai SaaS              OpenClaw (Ephemeral)
    │                        │                           │
    │  webhook fires         │                           │
    ├───────────────────────>│                           │
    │                        │  evaluate rules           │
    │                        │  score & classify          │
    │                        │                           │
    │                        │  POST /hooks/agent        │
    │                        ├──────────────────────────>│
    │                        │  {lead_data, persona,     │
    │                        │   tool_permissions}       │
    │                        │                           │  execute agent
    │                        │                           │  (browse, message,
    │                        │                           │   generate files)
    │                        │                           │
    │                        │  callback: results        │
    │                        │<─────────────────────────┤
    │                        │                           │  container dies
    │  notify results        │                           ×
    │<───────────────────────┤
```

### Key Constraints
- **10,000+ tenants** requiring hard data isolation
- **Ephemeral execution** — containers spin up per-webhook, die after completion
- **Multi-step agent workflows** — web browsing, WhatsApp messaging, file generation
- **VeloKai is the control plane** — OpenClaw is a dumb (but powerful) execution worker
- **Machine-to-machine trust** — VeloKai authenticates to OpenClaw, not end users

---

## 3. Critical Blockers (Must Fix)

### BLOCKER 1: Single-User Trust Model (CODE_WEAKNESSES.md #7)

**What**: OpenClaw's entire security model assumes one trusted operator per gateway instance. From `SECURITY.md`:

> *"OpenClaw does not model one gateway as a multi-tenant, adversarial user boundary."*
> *"Session identifiers are routing controls, not per-user authorization boundaries."*
> *"If one operator can view data from another operator on the same gateway, that is expected."*

**Impact for VeloKai**: If you run a shared gateway for multiple tenants:
- Tenant A can see Tenant B's session transcripts
- All tenants share the same credential store (`~/.openclaw/credentials/`)
- No per-tenant tool permission boundaries
- Memory/context from one tenant's agent could bleed into another's

**Resolution**: Do NOT share a gateway across tenants. Use **one ephemeral container per webhook execution**. This architecturally sidesteps the trust model issue — each container IS a single-user instance, the "user" being VeloKai acting on behalf of one tenant.

**File references**:
- `SECURITY.md:88-102` — Operator Trust Model
- `SECURITY.md:143-153` — One-User Trust Model
- `src/gateway/hooks.ts:1-17` — SaaS trust model documentation

---

### BLOCKER 2: Persistent Filesystem State Dependency

**What**: OpenClaw stores all persistent state on the local filesystem:

```
~/.openclaw/
├── openclaw.json              # Configuration
├── sessions/                   # Session transcripts (.jsonl)
├── credentials/oauth.json     # OAuth tokens
├── agents/<agentId>/          # Agent home + session logs
├── discord/                   # Channel state
├── workspace/                 # Skills/jobs workspace
├── media/                     # Media files
└── config-audit.jsonl         # Config audit trail
```

**Impact for VeloKai**:
- Ephemeral containers lose all state when destroyed
- No external session store (Redis, DB) — everything is disk-based
- Session transcripts at `~/.openclaw/sessions/<sessionId>.jsonl` need persistence if you want conversation continuity across webhook events
- Agent memory (QMD files, `MEMORY.md`) is filesystem-bound

**Resolution options**:
1. **Stateless mode (Phase 1)**: Accept that each webhook execution is independent — no conversation history across events. Container starts fresh, processes webhook, returns results, dies.
2. **External state store (Phase 3)**: Fork OpenClaw to use Redis/S3/DB for session persistence, or mount per-tenant volumes from a distributed filesystem.

**File references**:
- `src/config/paths.ts` — State directory resolution
- `src/config/sessions/store.ts` — Session file persistence
- `src/memory/qmd-manager.ts` — Memory management (2,098 LOC)

---

### BLOCKER 3: Configuration Loaded Once at Startup

**What**: OpenClaw loads its entire configuration from `openclaw.json` at process startup and caches it in memory. There is no mechanism to pass per-request configuration (e.g., different model provider keys, different tool permissions per tenant).

**Impact for VeloKai**: Each tenant may need:
- Different AI model provider API keys (their own OpenAI/Anthropic keys)
- Different tool permissions (Tenant A can use WhatsApp, Tenant B cannot)
- Different persona/system prompts
- Different webhook callback URLs

The `/hooks/agent` endpoint accepts a limited set of per-request overrides — `model` and `thinking` mode can be set per request, but NOT model provider API keys or tool policies. The full accepted payload is:

```typescript
{
  message: string;           // Required — the webhook data
  name?: string;             // Sender name (default: "Hook")
  agentId?: string;          // Route to specific agent profile
  sessionKey?: string;       // Namespace: "saas:<tenantId>:<sessionId>"
  model?: string;            // Per-request model override (partial win)
  thinking?: string;         // Thinking mode override
  timeoutSeconds?: number;   // Per-request timeout
  wakeMode?: "now" | "next-heartbeat";
  deliver?: boolean;         // Whether to deliver to channel
  channel?: string;          // Channel routing
  to?: string;               // Recipient
}
```

**Resolution**:
- **Phase 1**: Bake a shared config into the Docker image. VeloKai provides model keys and persona via env vars per container. Use `agentId` to route to pre-configured agent profiles per capability type. The `model` override is already available per-request.
- **Phase 3**: Extend the hooks API to accept per-request config overrides (model API key, tool policy, persona). This requires OpenClaw code changes.

**File references**:
- `src/config/io.ts` — Config loading (1,559 LOC)
- `src/config/env-vars.ts` — Environment variable handling
- `src/gateway/hooks.ts:53-79` — Hook config resolution

---

### BLOCKER 4: No Async Callback Mechanism

**What**: VeloKai needs "async with callback" — fire a webhook to OpenClaw, get an acknowledgment immediately, then receive results via a callback URL when the agent finishes.

**Good news**: The `/hooks/agent` endpoint already returns `{ ok: true, runId: string }` — so there IS a run identifier. However, the agent execution happens asynchronously in the background (fire-and-forget style), and there is **no callback URL mechanism** to notify VeloKai when the agent finishes. The only way to get results is:
1. Poll via WebSocket using `chat.history` with the session key (requires persistent connection)
2. Configure the agent to deliver results to a channel (Discord/Slack/etc.)

Neither of these works well for machine-to-machine SaaS integration.

**Impact for VeloKai**:
- No way to know when agent execution completes
- No way to receive structured results back
- No way to track progress or cancel runs via HTTP

**Resolution**: Implement a callback mechanism:
1. OpenClaw already returns a `runId` on hook acceptance
2. Agent executes asynchronously
3. On completion, OpenClaw POSTs results to a callback URL provided in the original request
4. VeloKai's `callbackUrl` field in the hook payload drives this

This requires OpenClaw code changes — likely a new hook mode or a wrapper service.

**File references**:
- `src/gateway/server-methods/chat.ts` — Chat execution (1,495 LOC)
- `src/gateway/hooks.ts` — Hook entry point

---

### BLOCKER 5: Container Cold Start Time

**What**: The OpenClaw Docker image is substantial:
- Base image: `node:22-bookworm` (~900MB)
- With browser (Chromium + Xvfb): +300MB
- With Docker CLI: +50MB
- Runtime startup: Config loading, schema validation, extension initialization

For ephemeral per-webhook containers, a cold start of 5-15 seconds is likely.

**Impact for VeloKai**: If a high-priority lead webhook fires, waiting 10+ seconds before the agent even starts processing defeats the purpose of "intelligent, fast routing."

**Resolution**:
- **Pre-warm container pools** (Fly.io Machines, Modal warm containers)
- **Slim image variant** (`--build-arg OPENCLAW_VARIANT=slim`) cuts ~200MB
- **Skip unnecessary initialization** — if a webhook only needs text processing, don't load browser/Discord/Telegram
- **Snapshot-based VMs** (Firecracker) can restore from memory snapshot in <1s

**File references**:
- `Dockerfile:14-16` — Variant selection
- `Dockerfile:157-171` — Browser installation (~300MB)
- `Dockerfile:173-203` — Docker CLI installation (~50MB)

---

### BLOCKER 6: Credential & Secret Isolation

**What**: OpenClaw stores all credentials in a shared location:
- Model provider keys: Environment variables or config file
- OAuth tokens: `~/.openclaw/credentials/oauth.json`
- Channel tokens: Config file (`TELEGRAM_BOT_TOKEN`, `DISCORD_BOT_TOKEN`, etc.)
- WhatsApp sessions: Persistent state in `~/.openclaw/` directory tree

**Impact for VeloKai**: If Tenant A uses their own OpenAI API key and WhatsApp Business account, these must NEVER be accessible to Tenant B's container.

**Resolution**:
- **Per-container environment injection**: VeloKai injects tenant-specific secrets as environment variables when spinning up the container. Container dies after execution — secrets never persist to disk.
- **Vault integration (Phase 3)**: HashiCorp Vault or AWS Secrets Manager with short-lived, per-request credentials.
- **Never mount shared volumes** — each container gets its own ephemeral filesystem.

---

## 4. High-Risk Gaps (Should Fix)

### GAP 1: Global Mutable State / Memory Leaks (CODE_WEAKNESSES.md #12)

**What**: 10+ unbounded `Map` objects at module scope grow without limit:

| Location | Map | Risk |
|----------|-----|------|
| `src/auto-reply/reply/queue/state.ts:21` | `FOLLOWUP_QUEUES` | Grows per session, never pruned |
| `src/discord/components-registry.ts:5-6` | `componentEntries`, `modalEntries` | Grows with message volume |
| `src/shared/config-eval.ts:151` | `hasBinaryCache` | Grows with unique binaries |
| `src/logging/diagnostic-session-state.ts:27` | `diagnosticSessionStates` | Pruned on access only |
| `src/agents/sandbox/browser-bridges.ts:3` | `BROWSER_BRIDGES` | No cleanup |
| `src/agents/bash-process-registry.ts:74-75` | `runningSessions`, `finishedSessions` | 30-min TTL |

**Impact for VeloKai ephemeral model**: MITIGATED. If containers are truly ephemeral (one execution, then destroyed), these leaks don't matter — the process never lives long enough for them to accumulate. However, if you adopt a **warm pool model** (containers handle multiple requests to reduce cold starts), these leaks become critical.

**Recommendation**: If using warm pools, add `maxSize` caps and scheduled eviction to all global Maps.

---

### GAP 2: Timer & Resource Leaks (CODE_WEAKNESSES.md #14)

**What**: `setInterval` timers without guaranteed cleanup:
- `src/discord/monitor/thread-bindings.manager.ts:441` — sweep timer
- `src/gateway/server.impl.ts:629` — presence timers
- `src/discord/monitor/provider.lifecycle.ts:188,206` — lifecycle timers

**Impact for VeloKai**: Containers that don't clean up timers on SIGTERM may hang during shutdown, causing zombie containers and wasted compute.

**Recommendation**: Add a SIGTERM handler that clears all intervals and resolves pending promises before exit. Essential for ephemeral container platforms (Fly.io, Modal) that send SIGTERM before killing.

---

### GAP 3: Sandbox Defaults to Off (CODE_WEAKNESSES.md #9)

**What**: `agents.defaults.sandbox.mode` defaults to `off`. Agents can execute arbitrary commands on the host.

**Impact for VeloKai**: If a malicious webhook payload triggers prompt injection (e.g., a crafted "company name" that injects shell commands), the agent has unrestricted host access.

**Recommendation**: Force `sandbox.mode: "all"` in VeloKai-controlled containers. Use the Docker sandbox (container-in-container) or restrict to `messaging` tool profile.

---

### GAP 4: Shell Execution Risks (CODE_WEAKNESSES.md #5)

**What**: Several places use `spawn()` with `shell: true`, expanding the command injection attack surface.

**Impact for VeloKai**: Webhook payloads contain user-submitted data (lead forms, company names, URLs). If this data reaches a shell execution path without sanitization, it's a command injection vector.

**Recommendation**:
- VeloKai MUST sanitize all webhook data before sending to OpenClaw
- Enable sandbox mode in OpenClaw containers
- Restrict tool permissions to the minimum required set per webhook type

---

### GAP 5: Unvalidated JSON.parse (CODE_WEAKNESSES.md #6)

**What**: 508 `JSON.parse` calls across 289 files, many without shape validation.

**Impact for VeloKai**: The hook endpoint parses the incoming webhook payload. If OpenClaw passes parsed-but-unvalidated data to agent tools, malformed payloads could cause unexpected behavior.

**Recommendation**: The hook entry point (`src/gateway/hooks.ts`) already limits body size (`maxBodyBytes: 256KB`). Add Zod schema validation for the VeloKai webhook payload format at the entry point.

---

## 5. Medium-Risk Concerns

### Fire-and-Forget Promises (CODE_WEAKNESSES.md #13)
25+ locations use `void promise.catch(...)` patterns. In ephemeral containers, these could cause the process to exit before background operations complete (e.g., sending a WhatsApp message). **Mitigation**: Ensure the main agent run `await`s all critical side effects before returning results to VeloKai.

### Empty Catch Blocks (CODE_WEAKNESSES.md #3)
50+ empty `catch {}` blocks. In a SaaS context, silent failures are dangerous — VeloKai needs to know if an agent execution failed. **Mitigation**: Wrap the entire hook execution in a try-catch that reports errors back via the callback URL.

### `as any` Type Casts (CODE_WEAKNESSES.md #4)
178 occurrences. Lower risk for VeloKai since the integration surface is narrow (hooks API only), but could cause runtime type errors in agent execution paths.

### Oversized Files (CODE_WEAKNESSES.md #1)
The agent runner (`attempt.ts` at 2,392 LOC with 68 imports) is the critical execution path for VeloKai. Its complexity increases the risk of edge-case bugs during agent execution. Not a blocker, but a maintenance burden.

---

## 6. What Already Works

OpenClaw has several features that align well with VeloKai's needs:

| Feature | Location | Why It Helps |
|---------|----------|-------------|
| `/hooks/agent` endpoint | `src/gateway/hooks.ts` | Purpose-built for SaaS integration — even documents the trust model |
| Session key namespacing | `hooks.ts:10` | `saas:<tenantId>:<sessionId>` pattern already documented |
| Hook token auth | `hooks.ts:8-9` | Shared secret between SaaS and gateway |
| Agent ID routing | `hooks.ts:41-44` | Different agents for different webhook types |
| Session key prefix allowlist | `hooks.ts:47-51` | Restrict which session prefixes are valid |
| Docker containerization | `Dockerfile` | Multi-stage, non-root, health checks, slim variant |
| Tool profiles | Config schema | `tools.profile: "messaging"` restricts tool access |
| Rate limiting | Hook config | Per-hook rate limiting protects against runaway tenants |
| Health check endpoints | `Dockerfile:228-229` | `/healthz` and `/readyz` for container orchestration |
| Body size limits | `hooks.ts:30` | 256KB default, configurable |
| `runId` returned on hook accept | `hooks.ts:456-485` | Already returns `{ ok: true, runId }` — foundation for async tracking |
| Per-request `model` override | Hook payload schema | Can switch models per webhook without config change |
| `timeoutSeconds` per request | Hook payload schema | Per-webhook timeout control |
| Timing-safe token comparison | `server-http.ts:403` | `safeEqualSecret()` prevents timing attacks |
| Health/readiness probes | `server-http.ts:89-94` | `/healthz` (liveness) + `/readyz` (readiness) |
| 9-stage request pipeline | `server-http.ts:640-774` | Hooks are first in pipeline — minimal overhead |
| Failed auth rate limiting | `server-http.ts:75-76` | 20 failed attempts per 60s per scope |

The hooks system was clearly designed with SaaS integration in mind (the trust model comment at the top of `hooks.ts` describes exactly this use case). The gateway also supports Tailscale identity verification, which could be useful for secure container-to-container communication.

---

## 7. Recommended Architecture

### Phase 1: Single-Tenant Proof of Concept (Now)

```
VeloKai Backend
    │
    │ POST /hooks/agent
    │ Headers: { Authorization: Bearer <hook-token> }
    │ Body: { agentId, sessionKey, message, callbackUrl }
    │
    ▼
┌─────────────────────────────────────┐
│  Single OpenClaw Container          │
│  (Railway / Fly.io)                │
│                                     │
│  Config: Your API keys, your agents │
│  Sandbox: ON                        │
│  Hooks: enabled, token-protected    │
│                                     │
│  ← Only YOUR Velokai account uses   │
└─────────────────────────────────────┘
```

**What to do**:
1. Deploy OpenClaw Docker image to Railway
2. Configure hooks with a shared token
3. Define agent profiles for your webhook types
4. VeloKai sends scored webhooks to `/hooks/agent`
5. Build a polling/callback wrapper for async results

---

### Phase 2: Multi-Tenant with Container Isolation (MVP SaaS)

```
VeloKai Backend (Control Plane)
    │
    │ Webhook arrives → score → route
    │
    ▼
┌─────────────────────────────────────────┐
│  Container Orchestrator                  │
│  (Fly.io Machines / Modal / AWS ECS)    │
│                                          │
│  spin_up(tenant_id, webhook_data) ──┐   │
│                                      │   │
│  ┌──────────────┐  ┌──────────────┐ │   │
│  │ Container A  │  │ Container B  │ │   │
│  │ Tenant: acme │  │ Tenant: corp │ │   │
│  │ Keys: acme's │  │ Keys: corp's │ │   │
│  │ Sandbox: ON  │  │ Sandbox: ON  │ │   │
│  │              │  │              │ │   │
│  │ Process hook │  │ Process hook │ │   │
│  │ → callback   │  │ → callback   │ │   │
│  │ → die        │  │ → die        │ │   │
│  └──────────────┘  └──────────────┘ │   │
│                                      │   │
└──────────────────────────────────────────┘
```

**What to do**:
1. Build a container orchestration layer in VeloKai
2. Pre-build OpenClaw Docker images with VeloKai-specific config baked in
3. On webhook: spin up container with tenant-specific env vars (API keys, persona)
4. Container processes the webhook, POSTs results to callback URL, exits
5. Hard isolation: each container has its own filesystem, process space, network

---

### Phase 3: Production SaaS at Scale

```
VeloKai Control Plane
    │
    ├── Tenant Registry (MongoDB)
    ├── Secret Vault (HashiCorp Vault / AWS Secrets Manager)
    ├── Session Store (Redis / DynamoDB) ← for conversation continuity
    ├── Result Queue (SQS / BullMQ) ← for async callbacks
    │
    ▼
┌──────────────────────────────────────────────────┐
│  Execution Platform (Fly.io Machines / Modal)    │
│                                                   │
│  Warm Pool: 10-50 pre-started containers         │
│  Cold Pool: auto-scale 0-500 on demand           │
│                                                   │
│  Per-request:                                     │
│  1. VeloKai claims a warm container               │
│  2. Injects tenant secrets via secure channel     │
│  3. Sends hook request                            │
│  4. Container executes, callbacks, resets state   │
│  5. Container returns to warm pool (or dies)      │
│                                                   │
│  Modified OpenClaw Fork:                          │
│  - External session store (Redis)                 │
│  - Callback URL support in hooks                  │
│  - Stateless config injection via API             │
│  - Graceful shutdown on SIGTERM                   │
│  - Global state cleanup between requests          │
│                                                   │
└──────────────────────────────────────────────────┘
```

---

## 8. Phased Remediation Plan

### Phase 1: Zero Code Changes (Now → 2 weeks)

| # | Task | Effort | Addresses |
|---|------|--------|-----------|
| 1 | Deploy OpenClaw Docker to Railway | 1 day | Proof of concept |
| 2 | Configure hooks with token auth | 2 hours | BLOCKER 1 (single-tenant workaround) |
| 3 | Define 3-5 agent profiles for webhook types | 1 day | Capability routing |
| 4 | Build VeloKai → OpenClaw HTTP client | 2 days | Integration layer |
| 5 | Build polling wrapper for async results | 2 days | BLOCKER 4 (workaround) |
| 6 | Enable sandbox mode in config | 1 hour | GAP 3 |
| 7 | Test end-to-end with real webhooks | 3 days | Validation |

### Phase 2: Container Orchestration (2-6 weeks)

| # | Task | Effort | Addresses |
|---|------|--------|-----------|
| 1 | Build container orchestrator in VeloKai | 1-2 weeks | BLOCKER 1 (hard isolation) |
| 2 | Create VeloKai-specific OpenClaw Docker image | 2 days | BLOCKER 5 (cold start) |
| 3 | Implement per-container env var injection | 3 days | BLOCKER 6 (secret isolation) |
| 4 | Build warm container pool | 1 week | BLOCKER 5 (cold start) |
| 5 | Implement callback URL mechanism (wrapper) | 3 days | BLOCKER 4 |
| 6 | Add SIGTERM graceful shutdown handler | 1 day | GAP 2 |
| 7 | Input sanitization layer in VeloKai | 3 days | GAP 4 |

### Phase 3: OpenClaw Fork & Scale (6-16 weeks)

| # | Task | Effort | Addresses |
|---|------|--------|-----------|
| 1 | Fork OpenClaw, add callback URL to hooks API | 1 week | BLOCKER 4 (native) |
| 2 | Add per-request config override to hooks | 2 weeks | BLOCKER 3 (native) |
| 3 | External session store (Redis adapter) | 2-3 weeks | BLOCKER 2 (conversation continuity) |
| 4 | Global state cleanup between warm-pool reuse | 1 week | GAP 1 |
| 5 | Add Zod validation for VeloKai payload format | 2 days | GAP 5 |
| 6 | Slim Docker image (strip unused channels) | 3 days | BLOCKER 5 |
| 7 | Monitoring & observability (per-tenant metrics) | 1-2 weeks | Operational |

---

## 9. Cost & Complexity Estimates

### Compute Cost Model (Ephemeral Containers)

| Metric | Estimate | Notes |
|--------|----------|-------|
| Container memory | 512MB-2GB | Depends on browser usage |
| Cold start | 5-15s | 1-3s with warm pool |
| Execution time | 10s-5min | Depends on agent complexity |
| Cost per execution (Fly.io) | ~$0.001-0.01 | shared-cpu-2x, 1GB RAM, 30s avg |
| 10K tenants × 10 webhooks/day | ~$1-10/day | At scale with warm pools |

### Fork Maintenance Cost

Forking OpenClaw means:
- Tracking upstream changes (active project with frequent commits)
- Merging security patches from upstream
- Maintaining your multi-tenancy layer through upstream API changes
- **Recommendation**: Minimize fork divergence. Prefer wrapper services and config-level changes over deep code modifications. Contribute multi-tenancy primitives upstream if possible.

---

## 10. Deep Dive: Cross-Tenant Data Leak Vectors

This section details the exact code paths where tenant data would leak if multiple tenants shared a single OpenClaw instance. These findings validate why **ephemeral per-tenant containers are mandatory** (not optional).

### LEAK VECTOR 1: Session Transcripts Are Co-mingled

**Path resolution** (`src/config/sessions/paths.ts`):
```
~/.openclaw/agents/{agentId}/sessions/{sessionId}.jsonl
```

There is **no tenant ID in the path**. If Tenant A and Tenant B both use `agentId: "default"`, their session transcripts live in the same directory. The `sessionKey` namespacing (`saas:tenantA:session1`) only affects the filename — not the directory. Any code that calls `listSessionFilesForAgent(agentId)` returns ALL tenants' sessions.

**Files**:
- `src/config/sessions/paths.ts` — `resolveAgentSessionsDir()` takes only `agentId`
- `src/memory/session-files.ts` — `listSessionFilesForAgent()` lists ALL `.jsonl` files for an agent

### LEAK VECTOR 2: Memory Embeddings Are Shared Per-Agent

**Memory index** (`src/memory/manager.ts`):
```typescript
// Cache key: "{agentId}:{workspaceDir}:{settings}"
// NO tenant ID in cache key
```

The `MemoryIndexManager` uses a **single SQLite database per agent**. The schema has tables for `files`, `chunks`, `chunks_vec` (vector embeddings), and `chunks_fts` (full-text search). None of these tables have a `tenantId` column.

If two tenants use the same agent, a `memory_search` call from Tenant A could return Tenant B's indexed content.

**Files**:
- `src/memory/manager.ts:62-150` — `MemoryIndexManager.get()` cache key has no tenant
- `src/memory/memory-schema.ts` — SQLite schema with no tenant column

### LEAK VECTOR 3: Sandbox Scope Ignores Tenants

**Sandbox scope hierarchy** (`src/agents/sandbox/types.ts:53`):
```typescript
export type SandboxScope = "session" | "agent" | "shared";
```

There is no `"tenant"` scope option. The `agent` scope shares a single workspace across all sessions for an agent — meaning all tenants on that agent share the same sandbox workspace files. The `session` scope isolates by session key, which partially mitigates this IF session keys are properly namespaced.

**Container naming** uses `sessionKey` and `agentId` only — no tenant isolation in Docker container names, network namespaces, or resource limits.

**Files**:
- `src/agents/sandbox/context.ts:20-65` — `ensureSandboxWorkspaceLayout()` uses scope + sessionKey
- `src/agents/sandbox/types.ts:72-85` — `SandboxContext` has no `tenantId` field
- `src/agents/sandbox/docker.ts` — Container lifecycle has no tenant concept

### LEAK VECTOR 4: Tool Policies Are Agent-Global

**Policy hierarchy** (`src/agents/sandbox-tool-policy.ts`):
```
agent-specific policy → global policy → default (allow all)
```

There is no tenant-level policy layer. If you configure agent "lead-processor" to allow web browsing and WhatsApp, ALL tenants using that agent get both capabilities. You cannot restrict Tenant A to web-only while allowing Tenant B to use WhatsApp on the same agent.

**Files**:
- `src/agents/sandbox-tool-policy.ts:21-37` — `pickSandboxToolPolicy()` merges agent + global only
- `src/agents/sandbox/types.ts:6-27` — `SandboxToolPolicySource` is `"agent" | "global" | "default"`

### LEAK VECTOR 5: Agent Runner Has No Tenant Context

**Runner parameters** (`src/agents/pi-embedded-runner/run.ts`):
```typescript
// RunEmbeddedPiAgentParams includes:
//   sessionKey, agentId, runId, workspaceDir
// NO tenantId parameter
```

The agent runner resolves execution "lanes" by session key only. Workspace directories are derived from `agentId`, not tenant ID. The retry/failover logic, auth profile selection, and context compaction all operate without tenant awareness.

**Files**:
- `src/agents/pi-embedded-runner/run.ts` — `runEmbeddedPiAgent()` params
- `src/agents/pi-embedded-runner/lanes.ts` — `resolveSessionLane()` uses sessionKey only

### Why Ephemeral Containers Solve All 5 Leak Vectors

| Leak Vector | Shared Gateway Risk | Ephemeral Container Fix |
|-------------|--------------------|-----------------------|
| Session transcripts | Co-mingled in same directory | Each container has its own `~/.openclaw/` |
| Memory embeddings | Shared SQLite per agent | Each container gets a fresh, empty database |
| Sandbox workspace | Shared per agent scope | Each container's filesystem is isolated |
| Tool policies | Agent-global, no tenant layer | Per-container config with tenant-specific policies |
| Agent runner | No tenant context in params | Container IS the tenant boundary — no sharing |

The ephemeral container model means you never need to add `tenantId` to OpenClaw's internals. Each container IS a single-tenant instance, perfectly aligned with OpenClaw's existing trust model.

---

## 11. Files Requiring Modification (If Forking)

If you choose to fork OpenClaw for Phase 3 (warm pool reuse, conversation continuity), these are the specific files that would need tenant-awareness:

### High Priority (Core Isolation)
| File | Change Required |
|------|----------------|
| `src/agents/pi-embedded-runner/run.ts` | Add `tenantId` to `RunEmbeddedPiAgentParams` |
| `src/agents/sandbox/context.ts` | Tenant-scoped workspace resolution |
| `src/agents/sandbox/types.ts` | Add `"tenant"` to `SandboxScope` |
| `src/memory/manager.ts` | `tenantId` in cache key and DB queries |
| `src/memory/memory-schema.ts` | Add `tenant_id` column to SQLite tables |
| `src/memory/session-files.ts` | Tenant-scoped file path listing |
| `src/config/sessions/paths.ts` | `tenantId` in directory path |

### Medium Priority (Policy & Containers)
| File | Change Required |
|------|----------------|
| `src/agents/sandbox-tool-policy.ts` | Tenant-level policy merging |
| `src/agents/sandbox/docker.ts` | Tenant-scoped container naming |
| `src/agents/sandbox/config.ts` | Tenant-scoped workspace root |
| `src/gateway/hooks.ts` | Accept `tenantId` in hook payload |

### Low Priority (Observability)
| File | Change Required |
|------|----------------|
| `src/security/audit.ts` | Log `tenantId` in all audit entries |
| `src/logging/diagnostic-session-state.ts` | Tenant-scoped diagnostic state |

---

## 12. Per-Tenant Dynamic Configuration via Modal

This section details how VeloKai's Agent Builder UI capabilities map to OpenClaw's configuration mechanisms, and how Modal sandboxes enable per-tenant injection.

### Skills (Agent Behavior & Persona)

**How skills work in OpenClaw**: Skills are `SKILL.md` markdown files discovered from filesystem directories at gateway startup and via a filesystem watcher. They are embedded directly into the agent's system prompt at runtime.

**Discovery paths** (`src/agents/skills/refresh.ts:60-77`):
```
{workspaceDir}/skills/*/SKILL.md
{workspaceDir}/.agents/skills/*/SKILL.md
~/.openclaw/skills/*/SKILL.md
~/.agents/skills/*/SKILL.md
{skills.load.extraDirs}/*/SKILL.md
```

**Per-agent filtering**: `agents.list[].skills` accepts a string array to whitelist which skills an agent can use.

**SKILL.md structure** (example from `skills/coding-agent/SKILL.md`):
```markdown
---
name: coding-agent
description: 'Delegate coding tasks...'
metadata:
  { "openclaw": { "emoji": "🧩", "requires": { "anyBins": ["claude"] } } }
---

# Coding Agent
Instructions for behavior...
```

**Modal injection**:
```python
# Write persona as a skill — gets embedded into system prompt
persona_skill = f"""---
name: velokai-persona
description: 'Agent persona and behavioral guidelines. Always active.'
---
# Agent Persona
{tenant_persona}
## Rules
- Represent {company_name}
- {custom_instructions}
"""
sb.exec("mkdir", "-p", "/home/node/.openclaw/skills/velokai-persona")
with sb.open("/home/node/.openclaw/skills/velokai-persona/SKILL.md", "w") as f:
    f.write(persona_skill)
```

### System Prompts

**Important**: System prompts are NOT a config field on `AgentConfig` (`agents.list[]`). There is no `agents.list[].systemPrompt` property. System prompts are **built dynamically at runtime** by `buildAgentSystemPrompt()` (`src/agents/system-prompt.ts`) from:
- Agent identity config (`agents.list[].identity.name`)
- Discovered skills (SKILL.md files)
- Workspace context
- Available tools
- Memory/recall guidance

**Channel-level systemPrompt exists**: `telegram.direct.systemPrompt`, `telegram.groups.systemPrompt`, `irc.systemPrompt`, etc. — but these are per-channel, not per-agent.

**The `/hooks/agent` payload does NOT accept a systemPrompt field**. Accepted fields:
```typescript
{ message, name, agentId, sessionKey, model, thinking,
  timeoutSeconds, wakeMode, deliver, channel, to }
```

**Modal injection strategy**: Use skills as the persona mechanism (see above). The skill content becomes part of the system prompt automatically.

### Tool Permissions

**How tools work**: Tool policies are configurable per-agent in `agents.list[]`:
```json
{
  "agents": {
    "list": [{
      "id": "lead-engagement",
      "tools": {
        "profile": "messaging",
        "allow": ["web_search", "browser"],
        "deny": ["file_write"]
      }
    }]
  }
}
```

**Source**: `src/agents/sandbox-tool-policy.ts:21-37` — hierarchy is `agent → global → default`.

**Modal injection**: Write the tool policy into `openclaw.json` before starting the gateway.

### MCP Tools

**Important correction**: OpenClaw DOES support MCP tools, but through the **ACPX plugin extension** (`extensions/acpx/`), not core config.

**Config path**: `plugins.entries.acpx.config.mcpServers`

**Schema** (`extensions/acpx/src/config.ts:21-25`):
```typescript
type McpServerConfig = {
  command: string;   // e.g., "npx"
  args?: string[];   // e.g., ["-y", "mcp-server-sqlite", "--db", "/data/leads.db"]
  env?: Record<string, string>;
};
```

**Key characteristics**:
- **Only local stdio transport** — MCP servers are spawned as child processes
- **Global config only** — no per-agent MCP server configuration
- **On-demand startup** — MCP servers start per ACP session, not at gateway startup
- **Tool discovery delegated** — the ACP agent (Claude, Codex) discovers tools from MCP servers via standard MCP protocol
- **Remote bridging possible** — use `npx mcp-remote@latest` to bridge HTTP/SSE MCP servers to local stdio

**Modal injection for MCP tools**:
```python
config = {
    "plugins": {
        "entries": {
            "acpx": {
                "config": {
                    "mcpServers": {
                        # VeloKai's own MCP server (for querying tenant's data)
                        "velokai": {
                            "command": "npx",
                            "args": ["-y", "mcp-remote@latest",
                                     tenant_config["mcp_endpoint"]],
                            "env": {
                                "VELOKAI_API_KEY": tenant_config["api_key"]
                            }
                        },
                        # Tenant's custom MCP server (e.g., their database)
                        "tenant-db": {
                            "command": "npx",
                            "args": ["-y", "mcp-server-sqlite",
                                     "--db", "/data/tenant.db"]
                        }
                    }
                }
            }
        }
    }
}
```

**Note**: The ACPX plugin must be included in the Docker image build (`--build-arg OPENCLAW_EXTENSIONS="acpx"`).

### Complete Per-Tenant Config Template

This is the full `openclaw.json` that VeloKai writes into each Modal sandbox:

```json
{
  "hooks": {
    "enabled": true,
    "token": "<generated-per-sandbox>",
    "allowRequestSessionKey": true,
    "allowedSessionKeyPrefixes": ["velokai:"]
  },
  "agents": {
    "list": [{
      "id": "default",
      "default": true,
      "identity": { "name": "<tenant_agent_name>" },
      "skills": ["velokai-persona", "lead-qualifier"],
      "tools": {
        "profile": "messaging",
        "allow": ["<tenant_allowed_tools>"],
        "deny": ["<tenant_denied_tools>"]
      }
    }],
    "defaults": {
      "sandbox": { "mode": "all" }
    }
  },
  "plugins": {
    "entries": {
      "acpx": {
        "config": {
          "mcpServers": {
            "velokai": {
              "command": "npx",
              "args": ["-y", "mcp-remote@latest", "<tenant_mcp_endpoint>"]
            }
          }
        }
      }
    }
  },
  "skills": {
    "entries": {
      "velokai-persona": { "enabled": true },
      "lead-qualifier": { "enabled": true }
    }
  }
}
```

### Capability Matrix: VeloKai Agent Builder → OpenClaw Config

| VeloKai Agent Builder Feature | OpenClaw Mechanism | Config Path | Per-Tenant via Modal |
|-------------------------------|-------------------|-------------|---------------------|
| Agent persona / instructions | **Skill** (SKILL.md file) | `~/.openclaw/skills/*/SKILL.md` | `sb.open()` to write file |
| Agent name / identity | Agent config | `agents.list[].identity.name` | Write `openclaw.json` |
| Web browsing | Built-in tools | `agents.list[].tools.allow: ["web_search", "browser"]` | Write `openclaw.json` |
| WhatsApp messaging | Built-in channel + hook payload | `channel: "whatsapp"` in POST body | Hook payload field |
| Telegram messaging | Built-in channel + hook payload | `channel: "telegram"` in POST body | Hook payload field |
| Slack messaging | Built-in channel + hook payload | `channel: "slack"` in POST body | Hook payload field |
| File generation | Built-in tools | `agents.list[].tools.allow: ["file_write"]` | Write `openclaw.json` |
| Database queries (MCP) | ACPX plugin MCP | `plugins.entries.acpx.config.mcpServers` | Write `openclaw.json` |
| Custom API calls (MCP) | ACPX plugin MCP + mcp-remote | Same as above, with remote bridge | Write `openclaw.json` |
| AI model selection | Hook payload + config | `model` field in POST body, or agent config | Hook payload field |
| Thinking mode | Hook payload | `thinking` field in POST body | Hook payload field |
| Execution timeout | Hook payload | `timeoutSeconds` field in POST body | Hook payload field |
| API keys (OpenAI, Anthropic) | Environment variables | `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` | `Sandbox.create(environment_variables=...)` |

---

## Appendix: File Reference Index

### Critical files for VeloKai integration
- `src/gateway/hooks.ts` — Hook entry point, SaaS trust model docs
- `src/gateway/hooks-mapping.ts` — Hook routing configuration
- `src/gateway/server-methods/chat.ts` — Chat/agent execution (1,495 LOC)
- `src/agents/pi-embedded-runner/run/attempt.ts` — Core agent runner (2,392 LOC)
- `src/config/io.ts` — Configuration loading (1,559 LOC)
- `src/config/paths.ts` — State directory paths
- `src/config/sessions/store.ts` — Session file persistence
- `src/config/env-vars.ts` — Environment variable handling

### Agent execution & isolation files
- `src/agents/pi-embedded-runner/run.ts` — Agent runner entry point (no tenantId param)
- `src/agents/pi-embedded-runner/run/attempt.ts` — Core execution (2,392 LOC, 68 imports)
- `src/agents/pi-embedded-runner/lanes.ts` — Session lane resolution (sessionKey only)
- `src/agents/sandbox/context.ts` — Sandbox workspace layout (no tenant scope)
- `src/agents/sandbox/types.ts` — SandboxScope: "session" | "agent" | "shared" (no "tenant")
- `src/agents/sandbox/config.ts` — Sandbox configuration resolution
- `src/agents/sandbox/docker.ts` — Docker container lifecycle
- `src/agents/sandbox-tool-policy.ts` — Tool policy: agent | global | default (no tenant)

### Memory & session storage files
- `src/memory/manager.ts` — MemoryIndexManager (cache key: agentId only)
- `src/memory/memory-schema.ts` — SQLite schema (no tenant_id column)
- `src/memory/session-files.ts` — Session file listing (all tenants mixed)
- `src/config/sessions/paths.ts` — Session path: `~/.openclaw/agents/{agentId}/sessions/`
- `src/config/types.memory.ts` — Memory config types (no tenant scope)

### Security-relevant files
- `SECURITY.md` — Trust model documentation
- `src/security/audit-extra.sync.ts` — Security audit (1,349 LOC)
- `src/security/audit-extra.async.ts` — Security audit (1,314 LOC)
- `src/agents/sandbox/sanitize-env-vars.ts` — Env var sanitization (uniform, not per-tenant)

### Skills, system prompts & MCP files
- `src/agents/skills/refresh.ts:60-77` — Skill discovery paths (filesystem-based)
- `src/agents/system-prompt.ts` — `buildAgentSystemPrompt()` (runtime assembly, no config field)
- `src/agents/pi-embedded-runner/system-prompt.ts` — Embedded system prompt builder
- `src/config/types.skills.ts` — SkillConfig type (enabled, apiKey, env, config)
- `src/config/types.agents.ts:61-95` — AgentConfig (NO systemPrompt field)
- `extensions/acpx/src/config.ts:21-25` — McpServerConfig type (command, args, env)
- `extensions/acpx/src/runtime.ts:675-700` — MCP server startup (per ACP session)
- `extensions/acpx/src/runtime-internals/mcp-proxy.mjs` — MCP stdio proxy (spawns child processes)
- `extensions/acpx/src/runtime-internals/mcp-agent-command.ts:109-121` — MCP proxy command builder

### Deployment files
- `Dockerfile` — Main container image (multi-stage, non-root, slim variant)
- `Dockerfile.sandbox` — Sandbox container (Debian slim, non-root `sandbox` user)
- `Dockerfile.sandbox-browser` — Browser sandbox (Chromium, X11VNC, NoVNC, ports 9222/5900/6080)
- `docker-compose.yml` — Local compose (gateway + CLI, no tenant isolation)
- `fly.toml` — Fly.io deployment (2GB RAM, persistent volume at /data)
- `render.yaml` — Render.com deployment (1GB disk at /data/.openclaw)
