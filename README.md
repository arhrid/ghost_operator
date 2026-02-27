# Ghost Operator

Self-healing infrastructure agent that monitors, detects, analyzes, and remediates cloud incidents autonomously — then writes post-mortems that make it smarter over time.

## Table of Contents

- [Architecture Overview](#architecture-overview)
- [Pipeline](#pipeline)
- [Core Components](#core-components)
  - [Orchestrator](#orchestrator)
  - [Detector Agent](#detector-agent)
  - [Analyzer Agent](#analyzer-agent)
  - [Remediator Agent](#remediator-agent)
  - [Reporter Agent](#reporter-agent)
- [Service Integrations](#service-integrations)
- [Knowledge Graph](#knowledge-graph)
- [Dashboard](#dashboard)
- [API Reference](#api-reference)
- [Installation Instructions](#installation-instructions)

---

## Architecture Overview

Ghost Operator follows a 4-stage pipeline architecture coordinated by a central orchestrator. Each stage is implemented as a specialized agent with a focused responsibility.

```
┌─────────────────────────────────────────────────────────────────────┐
│                         GHOST OPERATOR                              │
│                                                                     │
│   ┌──────────┐   ┌──────────┐   ┌──────────────┐   ┌───────────┐  │
│   │  DETECT  │──>│ ANALYZE  │──>│  KNOWLEDGE   │──>│    ACT    │  │
│   │          │   │          │   │              │   │           │  │
│   │ Yutori   │   │ Entity   │   │ Neo4j Graph  │   │ Render    │  │
│   │ Tavily   │   │ Severity │   │ Senso Memory │   │ Restart   │  │
│   │ Render   │   │ Classify │   │ Context      │   │ Scale     │  │
│   └──────────┘   └──────────┘   └──────────────┘   └───────────┘  │
│         │                                                  │        │
│         └──────────── 60-second cycle ─────────────────────┘        │
│                                                                     │
│   ┌─────────────────────────────────────────────────────────────┐   │
│   │                    EXPRESS SERVER                            │   │
│   │  REST API  ·  SSE Stream  ·  Dashboard  ·  Health Check     │   │
│   └─────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Pipeline

Every 60 seconds, Ghost Operator runs a full detection cycle through all four stages:

```
 ┌─────────────────┐
 │  Detection Cycle │
 │  (every 60s)     │
 └────────┬────────┘
          │
          v
 ┌─────────────────┐     Render health checks
 │    1. DETECT     │────>Tavily outage search
 │                  │     Yutori scout monitoring
 └────────┬────────┘
          │ DetectionSignal[]
          │ (skip if empty)
          v
 ┌─────────────────┐     Entity extraction (50+ services)
 │    2. ANALYZE    │────>Error classification (HTTP, system)
 │                  │     Severity scoring (critical/warning/info)
 └────────┬────────┘     Root cause inference
          │ Incident
          v
 ┌─────────────────┐     Query similar past incidents (Neo4j)
 │   3. REMEDIATE   │────>Search past context (Senso)
 │                  │     Execute actions via Render API
 └────────┬────────┘     (restart, scale, resume, alert)
          │ RemediationAction[]
          v
 ┌─────────────────┐     Build incident timeline
 │    4. REPORT     │────>Generate post-mortem
 │                  │     Store in Neo4j + Senso
 └────────┬────────┘     Broadcast to dashboard
          │
          v
 ┌─────────────────┐
 │  Cycle Complete  │──> Wait for next cycle
 └─────────────────┘
```

---

## Core Components

### Orchestrator

**File:** `src/index.ts`

The central coordinator that manages the entire pipeline. It initializes all agents and services, schedules detection cycles via `node-cron`, and exposes the Express server for the REST API, SSE stream, and dashboard.

**Responsibilities:**
- Initialize and wire together all agents and service clients
- Run the detect &rarr; analyze &rarr; remediate &rarr; report pipeline on schedule
- Maintain in-memory state (incidents list, activity log)
- Broadcast real-time updates to connected dashboard clients via SSE

### Detector Agent

**File:** `src/agents/detector.ts`

Monitors infrastructure across three independent sources and emits raw detection signals.

```
                   ┌──────────────────┐
                   │  Detector Agent  │
                   └────────┬─────────┘
                            │
            ┌───────────────┼───────────────┐
            v               v               v
   ┌────────────┐   ┌────────────┐   ┌────────────┐
   │   Render   │   │   Tavily   │   │   Yutori   │
   │   Health   │   │   Search   │   │   Scouts   │
   │   Checks   │   │            │   │            │
   └──────┬─────┘   └──────┬─────┘   └──────┬─────┘
          │                │                │
          v                v                v
   Suspended /      Outage reports     Status pages,
   unhealthy        from the web       Reddit, HN
   services                            keyword matches
          │                │                │
          └───────────┬────┘────────────────┘
                      v
             DetectionSignal[]
```

### Analyzer Agent

**File:** `src/agents/analyzer.ts`

Transforms raw detection signals into a structured incident with actionable metadata.

| Capability | Method | Details |
|---|---|---|
| **Entity Extraction** | Pattern matching | Identifies 50+ cloud services (AWS, GCP, Azure, Render, etc.) |
| **Error Detection** | Regex patterns | Extracts HTTP codes (4xx/5xx) and system errors (OOM, ECONNREFUSED, timeouts) |
| **Severity Classification** | Keyword analysis | Assigns `critical`, `warning`, or `info` based on signal content and source |
| **Root Cause Inference** | Heuristic rules | Suggests causes: server error, timeout, memory exhaustion, DNS, TLS, bad deploy |

### Remediator Agent

**File:** `src/agents/remediator.ts`

Decides and executes automated remediation actions based on severity and historical knowledge.

```
 Incident ──> Query Neo4j for similar past incidents
          ──> Search Senso for relevant post-mortems
          │
          v
 ┌──────────────────────────────────────────────┐
 │          Severity-Based Decision              │
 │                                               │
 │  info     ──> No-op (monitor only)            │
 │  warning  ──> Restart affected service        │
 │  critical ──> Restart + Scale to 2 instances  │
 └──────────────────────────────────────────────┘
          │
          v
 Render API actions: resume, restart, scale
 Fallback: create alert if no matching service
```

### Reporter Agent

**File:** `src/agents/reporter.ts`

Generates structured post-mortems and persists them for future learning.

**Post-mortem contents:**
- Full timeline of events (detection, signals, remediation, resolution)
- Impact summary (affected services, error codes, severity)
- Root cause analysis
- Remediation details and outcomes
- Lessons learned and recommendations

**Storage:** Post-mortems are saved to both **Neo4j** (linked to the incident in the knowledge graph) and **Senso** (searchable agent memory), enabling the system to learn from every incident.

---

## Service Integrations

| Service | Role | How It's Used |
|---------|------|---------------|
| **[Tavily](https://tavily.com)** | Real-time web search | Searches for outage reports and status page updates across the web |
| **[Yutori](https://yutori.ai)** | Continuous web scouting | Monitors status pages (AWS, GCP, Azure, Render), Reddit, and Hacker News for incident keywords |
| **[Neo4j](https://neo4j.com)** | Incident knowledge graph | Stores incidents, services, errors, root causes, remediations, and post-mortems as a connected graph |
| **[Render](https://render.com)** | Deployment platform & remediation target | Hosts the service, provides health checks, and exposes APIs for restart/scale/resume |
| **[Senso.ai](https://senso.ai)** | Searchable agent memory | Stores verified post-mortems for full-text search, enabling the remediator to learn from past incidents |

---

## Knowledge Graph

Ghost Operator builds a persistent knowledge graph in Neo4j that grows smarter with every incident.

```
                         ┌──────────┐
                ┌───────>│ Service  │
                │        └──────────┘
                │ AFFECTS
                │
 ┌──────────┐───┤         ┌──────────┐
 │ Incident │   ├────────>│  Error   │
 └──────────┘   │HAS_ERROR└──────────┘
                │
                │CAUSED_BY ┌───────────┐
                ├────────>│ RootCause │
                │          └───────────┘
                │
                │REMEDIATED_BY ┌──────────────┐
                ├─────────────>│ Remediation  │
                │              └──────────────┘
                │
                │HAS_POSTMORTEM┌─────────────┐
                └─────────────>│ Post-Mortem  │
                               └─────────────┘
```

This graph enables:
- **Similarity queries** — find past incidents by matching service or error
- **Root cause pattern analysis** — identify recurring failure modes
- **Remediation tracking** — measure success rates of past actions
- **Continuous learning** — the remediator checks this graph before acting

---

## Dashboard

Ghost Operator ships with a real-time monitoring dashboard at the `/dashboard` endpoint.

**Features:**
- **System Health** — uptime, incident count, last detection time
- **Knowledge Graph Stats** — counts of incidents, services, errors, root causes, remediations, post-mortems
- **Incident Feed** — live list of incidents color-coded by severity with affected services and action counts
- **Agent Activity Log** — real-time log of all agent operations with timestamps
- **Manual Controls** — trigger a detection scan on demand

**Real-time updates** are delivered via Server-Sent Events (SSE) with automatic reconnection.

---

## API Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | `GET` | System health check (uptime, incident count, last detection) |
| `/dashboard` | `GET` | Real-time monitoring dashboard UI |
| `/events` | `GET` | Server-Sent Events stream for live updates |
| `/api/incidents` | `GET` | List all incidents (newest first) |
| `/api/incidents/:id` | `GET` | Get details of a specific incident |
| `/api/activity` | `GET` | Last 100 activity log entries (newest first) |
| `/api/graph/stats` | `GET` | Knowledge graph statistics (node counts by type) |
| `/api/graph` | `GET` | Full incident graph as nodes and edges (max 200) |
| `/api/trigger` | `POST` | Manually trigger a detection cycle |

---

## Installation Instructions

### Prerequisites

- **Node.js** >= 20.0 ([download](https://nodejs.org))
- **npm** (included with Node.js)
- **Git**

### 1. Clone and Install

```bash
git clone https://github.com/arhrid/ghost_operator.git
cd ghost_operator
npm install
```

### 2. Configure API Keys

Ghost Operator integrates with five external services. You'll need to sign up for each and obtain an API key.

```bash
cp .env.example .env
```

Open `.env` and fill in the values:

| Variable | Required | Where to Get It |
|----------|----------|-----------------|
| `PORT` | No | Defaults to `3000` |
| `TAVILY_API_KEY` | Yes | Sign up at [tavily.com](https://tavily.com) and generate an API key from the dashboard |
| `YUTORI_API_KEY` | Yes | Sign up at [yutori.ai](https://yutori.ai) and create an API key |
| `NEO4J_URI` | Yes | Create a free instance at [Neo4j Sandbox](https://sandbox.neo4j.com) — use the Bolt URL (e.g. `bolt://xxx.databases.neo4j.io:7687`) |
| `NEO4J_USER` | Yes | Provided by your Neo4j instance (default: `neo4j`) |
| `NEO4J_PASSWORD` | Yes | Provided by your Neo4j instance |
| `NEO4J_DATABASE` | No | Defaults to `neo4j` |
| `RENDER_API_KEY` | Yes | Go to [Render Dashboard](https://dashboard.render.com) → Account Settings → API Keys |
| `SENSO_API_KEY` | Yes | Sign up at [senso.ai](https://senso.ai) and generate an API key |
| `SENSO_ORGANIZATION_ID` | Yes | Found in your Senso.ai organization settings |

### 3. Set Up Neo4j

Ghost Operator uses Neo4j as its knowledge graph. The quickest way to get started:

1. Go to [sandbox.neo4j.com](https://sandbox.neo4j.com) and create a free **Blank Sandbox**
2. Once provisioned, copy the **Bolt URL**, **Username**, and **Password** into your `.env`:
   ```env
   NEO4J_URI=bolt://<your-sandbox-host>:7687
   NEO4J_USER=neo4j
   NEO4J_PASSWORD=<your-sandbox-password>
   NEO4J_DATABASE=neo4j
   ```
3. Ghost Operator will automatically create the necessary nodes and relationships on first run — no manual schema setup is needed

> **Note:** Neo4j Sandbox instances expire after a few days. For persistent usage, consider [Neo4j AuraDB Free](https://neo4j.com/cloud/aura-free/) or a self-hosted instance.

### 4. Run Locally

**Development** (auto-reloads with ts-node):

```bash
npm run dev
```

**Production build:**

```bash
npm run build
npm start
```

Once running, open your browser to:
- **Dashboard:** [http://localhost:3000/dashboard](http://localhost:3000/dashboard)
- **Health check:** [http://localhost:3000/health](http://localhost:3000/health)

Ghost Operator will begin its detection cycle every 60 seconds automatically. You can also trigger a scan manually from the dashboard or via `POST /api/trigger`.

### 5. Deploy to Render

Ghost Operator includes a `render.yaml` for one-click deployment on [Render](https://render.com).

**Option A — Blueprint (recommended):**

1. Push your repository to GitHub
2. Go to [Render Dashboard](https://dashboard.render.com) → **New** → **Blueprint**
3. Connect your GitHub repo — Render will detect `render.yaml` automatically
4. Fill in the environment variables when prompted
5. Click **Apply** to deploy

**Option B — Manual service:**

1. Go to [Render Dashboard](https://dashboard.render.com) → **New** → **Web Service**
2. Connect your GitHub repo
3. Configure:
   - **Build Command:** `npm install && npm run build`
   - **Start Command:** `npm start`
   - **Health Check Path:** `/health`
4. Add all environment variables from your `.env` under the **Environment** tab
5. Deploy

Once deployed, the dashboard will be available at your Render service URL (e.g. `https://ghost-operator.onrender.com/dashboard`).

### Verify Installation

After starting (locally or on Render), confirm everything is working:

```bash
# Check system health
curl http://localhost:3000/health

# Trigger a manual detection scan
curl -X POST http://localhost:3000/api/trigger

# View incidents
curl http://localhost:3000/api/incidents
```

Expected `/health` response:

```json
{
  "status": "ok",
  "uptime": 12,
  "incidents": 0,
  "lastDetection": null
}
```

---

## Project Structure

```
ghost_operator/
├── src/
│   ├── index.ts              # Orchestrator & Express server
│   ├── config.ts             # Configuration management
│   ├── types/
│   │   └── index.ts          # TypeScript type definitions
│   ├── agents/
│   │   ├── detector.ts       # Detection agent
│   │   ├── analyzer.ts       # Analysis agent
│   │   ├── remediator.ts     # Remediation agent
│   │   └── reporter.ts       # Reporting agent
│   ├── services/
│   │   ├── neo4j.ts          # Neo4j graph database client
│   │   ├── tavily.ts         # Tavily search API client
│   │   ├── yutori.ts         # Yutori monitoring client
│   │   ├── render.ts         # Render deployment API client
│   │   └── senso.ts          # Senso agent memory client
│   └── dashboard/
│       └── index.html        # Real-time dashboard UI
├── package.json
├── tsconfig.json
├── render.yaml               # Render deployment config
└── .env.example              # Environment variable template
```

---

## Tech Stack

| Technology | Purpose |
|------------|---------|
| TypeScript | Type-safe development |
| Node.js | Runtime (>= 20) |
| Express | HTTP server & routing |
| Neo4j Driver | Graph database client |
| Axios | HTTP client for external APIs |
| node-cron | Scheduled detection cycles |
| uuid | Unique incident ID generation |
