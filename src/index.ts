import express, { Request, Response } from 'express';
import cors from 'cors';
import cron from 'node-cron';
import path from 'path';

import { config } from './config';
import { Neo4jClient } from './services/neo4j';
import { DetectorAgent } from './agents/detector';
import { AnalyzerAgent } from './agents/analyzer';
import { RemediatorAgent } from './agents/remediator';
import { ReporterAgent } from './agents/reporter';
import { Incident, ActivityLogEntry } from './types';

// ── State ────────────────────────────────────────────────────
const incidents: Incident[] = [];
const activityLog: ActivityLogEntry[] = [];
const sseClients: Set<Response> = new Set();

// ── Services & Agents ────────────────────────────────────────
const neo4j = new Neo4jClient();
const detector = new DetectorAgent();
const analyzer = new AnalyzerAgent();
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
async function runPipeline() {
  log('detector', 'Starting detection cycle...');

  // 1. Detect
  const signals = await detector.detect();
  if (signals.length === 0) {
    log('detector', 'No anomalies detected');
    return;
  }

  log('detector', `Detected ${signals.length} signal(s)`, signals.map(s => s.title));

  // 2. Analyze
  log('analyzer', 'Analyzing signals...');
  const incident = analyzer.analyze(signals);
  if (!incident) {
    log('analyzer', 'No actionable incident from signals');
    return;
  }

  log('analyzer', `Incident created: [${incident.severity}] ${incident.title}`, { id: incident.id });
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
  }

  // 5. Report
  log('reporter', `Generating post-mortem for incident: ${incident.id}`);
  const postMortem = await reporter.generatePostMortem(incident);
  incident.postMortem = postMortem;
  log('reporter', `Post-mortem generated: ${postMortem.title}`);

  incidents.push(incident);
  broadcast({ type: 'incident_complete', payload: incident });
}

// ── Express App ──────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json());

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

// ── Startup ──────────────────────────────────────────────────
async function start() {
  console.log('🔮 Ghost Operator starting...');

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
    console.log(`🔮 Ghost Operator running on port ${config.port}`);
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
