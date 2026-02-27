# Ghost Operator

Self-healing infrastructure agent that monitors, detects, analyzes, and remediates incidents autonomously — then writes post-mortems that make it smarter over time.

## Architecture

```
DETECT  →  ANALYZE  →  KNOWLEDGE  →  ACT
Yutori     Entity      Neo4j         Render API
Tavily     Severity    Senso         Post-mortem
Render     Classify    Context       Generation
```

## Sponsor Integrations

| Tool | Role |
|------|------|
| **Tavily** | Real-time web search for outage reports and status pages |
| **Yutori** | Continuous scouting of status pages, Reddit, HN for incidents |
| **Neo4j** | Incident knowledge graph (Incident → Service → Error → RootCause → Remediation) |
| **Render** | Deploy + self-monitor via API (restart, scale, health checks) |
| **Senso.ai** | Searchable agent memory storing verified post-mortems |

## Quick Start

```bash
# Install dependencies
npm install

# Copy and fill in environment variables
cp .env.example .env

# Development
npm run dev

# Production build
npm run build && npm start
```

## Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Health check |
| `GET /dashboard` | Real-time dashboard |
| `GET /events` | SSE stream for live updates |
| `GET /api/incidents` | List all incidents |
| `GET /api/activity` | Agent activity log |
| `GET /api/graph/stats` | Knowledge graph statistics |
| `POST /api/trigger` | Manually trigger a detection cycle |

## Pipeline

1. **Detect** — Render health checks + Tavily outage search + Yutori scout monitoring
2. **Analyze** — Entity extraction, error classification, severity scoring
3. **Remediate** — Query past incidents from Neo4j, execute via Render API (restart/scale)
4. **Report** — Generate post-mortem, store in Senso + Neo4j for future learning
