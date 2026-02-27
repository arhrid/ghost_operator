import express, { Request, Response } from 'express';
import cors from 'cors';
import cron from 'node-cron';
import path from 'path';
import { v4 as uuid } from 'uuid';

import { config } from './config';
import { Neo4jClient } from './services/neo4j';
import { YutoriClient } from './services/yutori';
import { DetectorAgent } from './agents/detector';
import { AnalyzerAgent } from './agents/analyzer';
import { RemediatorAgent } from './agents/remediator';
import { ReporterAgent } from './agents/reporter';
import { Incident, ActivityLogEntry, DetectionSignal } from './types';

// ── State ────────────────────────────────────────────────────
const incidents: Incident[] = [];
const activityLog: ActivityLogEntry[] = [];
const sseClients: Set<Response> = new Set();

// ── Services & Agents ────────────────────────────────────────
const neo4j = new Neo4jClient();
const yutori = new YutoriClient();
const detector = new DetectorAgent();
const analyzer = new AnalyzerAgent(yutori);
const remediator = new RemediatorAgent(neo4j);
const reporter = new ReporterAgent(neo4j);

// ── Helpers ──────────────────────────────────────────────────
function log(agent: ActivityLogEntry['agent'], message: string, data?: unknown) {
  const entry: ActivityLogEntry = {
    timestamp: new Date().toISOString(),
    agent,
    message,
    data,
  };
  activityLog.push(entry);
  // Keep last 500 entries
  if (activityLog.length > 500) activityLog.shift();
  broadcast({ type: 'activity', payload: entry });
  console.log(`[${agent}] ${message}`);
}

function broadcast(data: unknown) {
  const message = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    client.write(message);
  }
}

// ── Pipeline ─────────────────────────────────────────────────
async function runPipeline(syntheticSignals?: DetectionSignal[]) {
  broadcast({ type: 'pipeline_start', payload: { timestamp: new Date().toISOString() } });

  // 1. Detect
  log('detector', 'Starting detection cycle...');
  const signals = syntheticSignals ?? await detector.detect();

  broadcast({ type: 'detection_complete', payload: { signalCount: signals.length } });

  if (signals.length === 0) {
    log('detector', 'No anomalies detected');
    broadcast({ type: 'pipeline_complete', payload: { result: 'no_signals' } });
    return;
  }

  log('detector', `Detected ${signals.length} signal(s)`, signals.map(s => s.title));

  // 2. Analyze
  log('analyzer', 'Analyzing signals...');
  const incident = await analyzer.analyze(signals);

  broadcast({ type: 'analysis_complete', payload: { incidentId: incident?.id ?? null } });

  if (!incident) {
    log('analyzer', 'No actionable incident from signals');
    broadcast({ type: 'pipeline_complete', payload: { result: 'no_incident' } });
    return;
  }

  log('analyzer', `Incident created: [${incident.severity}] ${incident.title}`, { id: incident.id });
  if (incident.researchSources?.length) {
    log('analyzer', `Yutori research found ${incident.researchSources.length} source(s)`);
  }
  broadcast({ type: 'incident', payload: incident });

  // 3. Store in Neo4j
  await neo4j.createIncident(incident);
  log('system', `Incident stored in knowledge graph: ${incident.id}`);

  // 4. Remediate
  log('remediator', `Remediating incident: ${incident.id}`);
  const actions = await remediator.remediate(incident);
  incident.remediationActions = actions;

  for (const action of actions) {
    log('remediator', `${action.type}: ${action.description} → ${action.success ? 'OK' : 'FAILED'}`);
    broadcast({ type: 'remediation_action', payload: action });
  }

  // 5. Validate remediation
  log('remediator', 'Validating remediation (re-checking service health in 10s)...');
  const validation = await remediator.validateRemediation(incident);

  broadcast({ type: 'validation_complete', payload: { healthy: validation.healthy, retried: validation.retried, resolvedAt: incident.resolvedAt } });

  if (validation.healthy) {
    log('remediator', `Validation passed — incident ${incident.id} resolved`);
  } else if (validation.retried) {
    log('remediator', `Validation failed — escalated with retry actions`);
  } else {
    log('remediator', `Validation failed — services still unhealthy`);
  }

  // 6. Report
  log('reporter', `Generating post-mortem for incident: ${incident.id}`);
  const postMortem = await reporter.generatePostMortem(incident);
  incident.postMortem = postMortem;
  log('reporter', `Post-mortem generated: ${postMortem.title}`);

  broadcast({ type: 'postmortem_complete', payload: { incidentId: incident.id } });

  incidents.push(incident);
  broadcast({ type: 'incident_complete', payload: incident });
  broadcast({ type: 'pipeline_complete', payload: { result: 'completed', incidentId: incident.id } });
}

// ── Simulation Scenarios ─────────────────────────────────────
const SIMULATION_SCENARIOS: Record<string, { name: string; signals: DetectionSignal[] }> = {
  service_down: {
    name: 'Service Down',
    signals: [
      {
        source: 'render_health',
        title: 'Service unhealthy: ghost-api',
        summary: 'Render service "ghost-api" (srv-sim001) is suspended — 503 errors detected',
        timestamp: new Date().toISOString(),
        raw: { id: 'srv-sim001', name: 'ghost-api', status: 'suspended' },
      },
      {
        source: 'tavily',
        title: 'Render platform outage reported',
        summary: 'Multiple users reporting 503 and 500 errors on Render-hosted services. Render status page shows degraded performance.',
        url: 'https://status.render.com',
        timestamp: new Date().toISOString(),
      },
    ],
  },
  high_latency: {
    name: 'High Latency',
    signals: [
      {
        source: 'yutori',
        title: 'Elevated latency on cloud services',
        summary: 'Latency spike detected across AWS us-east-1 region. Redis and Postgres connections showing timeout and ETIMEDOUT errors. Services degraded.',
        url: 'https://status.aws.amazon.com',
        timestamp: new Date().toISOString(),
      },
      {
        source: 'render_health',
        title: 'Service degraded: ghost-worker',
        summary: 'Render service "ghost-worker" showing slow response times, elevated error rates',
        timestamp: new Date().toISOString(),
        raw: { id: 'srv-sim002', name: 'ghost-worker', status: 'active' },
      },
    ],
  },
  memory_exhaustion: {
    name: 'Memory Exhaustion',
    signals: [
      {
        source: 'render_health',
        title: 'Service critical: ghost-api',
        summary: 'Render service "ghost-api" (srv-sim003) is down — OOM killed. Out of memory error detected. ENOMEM.',
        timestamp: new Date().toISOString(),
        raw: { id: 'srv-sim003', name: 'ghost-api', status: 'suspended' },
      },
      {
        source: 'tavily',
        title: 'Memory exhaustion incident on Render',
        summary: 'Critical outage: service crashed due to memory exhaustion. OOM killer triggered. Major impact on availability.',
        timestamp: new Date().toISOString(),
      },
    ],
  },
};

// ── Express App ──────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

// Redirect root to dashboard
app.get('/', (_req: Request, res: Response) => {
  res.redirect('/dashboard');
});

// Serve dashboard
app.use('/dashboard', express.static(path.join(__dirname, 'dashboard')));

// Health endpoint
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'healthy',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    incidents: incidents.length,
    lastCheck: activityLog.filter(l => l.agent === 'detector').pop()?.timestamp ?? null,
  });
});

// SSE endpoint for real-time updates
app.get('/events', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));

  // Send current state
  res.write(`data: ${JSON.stringify({ type: 'connected', payload: { incidents: incidents.length } })}\n\n`);
});

// API endpoints
app.get('/api/incidents', (_req: Request, res: Response) => {
  res.json(incidents.slice().reverse());
});

app.get('/api/incidents/:id', (req: Request, res: Response) => {
  const incident = incidents.find(i => i.id === req.params.id);
  if (!incident) return res.status(404).json({ error: 'Not found' });
  res.json(incident);
});

app.get('/api/activity', (_req: Request, res: Response) => {
  res.json(activityLog.slice(-100).reverse());
});

app.get('/api/graph/stats', async (_req: Request, res: Response) => {
  const stats = await neo4j.getGraphStats();
  res.json(stats);
});

app.get('/api/graph', async (_req: Request, res: Response) => {
  const graph = await neo4j.getIncidentGraph();
  res.json(graph);
});

// Manual trigger for demo
app.post('/api/trigger', async (_req: Request, res: Response) => {
  log('system', 'Manual detection cycle triggered');
  runPipeline().catch(err => log('system', `Pipeline error: ${err.message}`));
  res.json({ message: 'Detection cycle triggered' });
});

// Simulation endpoint
app.post('/api/simulate', (req: Request, res: Response) => {
  const scenario = req.body.scenario ?? 'service_down';
  const preset = SIMULATION_SCENARIOS[scenario];

  if (!preset) {
    return res.status(400).json({
      error: 'Unknown scenario',
      available: Object.keys(SIMULATION_SCENARIOS).map(k => ({ id: k, name: SIMULATION_SCENARIOS[k].name })),
    });
  }

  // Refresh timestamps to now
  const signals = preset.signals.map(s => ({ ...s, timestamp: new Date().toISOString() }));

  log('system', `Simulation triggered: ${preset.name}`);
  runPipeline(signals).catch(err => log('system', `Pipeline error: ${err.message}`));
  res.json({ message: `Simulation started: ${preset.name}`, scenario });
});

// List available simulation scenarios
app.get('/api/simulate/scenarios', (_req: Request, res: Response) => {
  res.json(
    Object.entries(SIMULATION_SCENARIOS).map(([id, s]) => ({ id, name: s.name, signalCount: s.signals.length }))
  );
});

// ── Startup ──────────────────────────────────────────────────
async function start() {
  console.log('Ghost Operator starting...');

  // Connect Neo4j
  await neo4j.connect();

  // Initialize Yutori scouts
  await detector.initScouts();
  log('system', 'Yutori scouts initialized');

  // Schedule detection loop
  cron.schedule(`*/${config.detectionIntervalSec} * * * * *`, () => {
    runPipeline().catch(err => log('system', `Pipeline error: ${err.message}`));
  });
  log('system', `Detection loop scheduled every ${config.detectionIntervalSec}s`);

  // Start Express server
  app.listen(config.port, () => {
    console.log(`Ghost Operator running on port ${config.port}`);
    console.log(`   Dashboard: http://localhost:${config.port}/dashboard`);
    console.log(`   Health:    http://localhost:${config.port}/health`);
    console.log(`   Events:    http://localhost:${config.port}/events`);
    log('system', `Server started on port ${config.port}`);
  });
}

start().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
