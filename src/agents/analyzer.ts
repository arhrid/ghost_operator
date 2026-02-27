import { v4 as uuid } from 'uuid';
import { DetectionSignal, Incident, Severity } from '../types';

// Well-known cloud/infra services for entity extraction
const KNOWN_SERVICES = [
  'aws', 'amazon', 'ec2', 's3', 'lambda', 'cloudfront', 'rds', 'dynamodb',
  'azure', 'google cloud', 'gcp', 'gke', 'cloud run', 'bigquery',
  'render', 'vercel', 'netlify', 'heroku', 'cloudflare', 'fastly',
  'github', 'gitlab', 'docker', 'kubernetes', 'k8s',
  'postgres', 'mysql', 'redis', 'mongodb', 'elasticsearch',
  'stripe', 'twilio', 'sendgrid', 'datadog', 'pagerduty',
  'slack', 'discord', 'npm', 'pypi',
];

// HTTP error code patterns
const ERROR_PATTERNS = [
  /\b[45]\d{2}\b/g,          // 4xx/5xx status codes
  /timeout/gi,
  /connection refused/gi,
  /ECONNREFUSED/g,
  /ETIMEDOUT/g,
  /OOM|out of memory/gi,
  /segfault|segmentation fault/gi,
  /ENOMEM/g,
  /ENOSPC/g,
];

// Severity keywords
const CRITICAL_KEYWORDS = ['outage', 'down', 'critical', 'major', 'complete failure', 'data loss', 'security breach'];
const WARNING_KEYWORDS = ['degraded', 'slow', 'intermittent', 'partial', 'elevated error', 'latency'];

export class AnalyzerAgent {
  /** Analyze a batch of detection signals into an incident */
  analyze(signals: DetectionSignal[]): Incident | null {
    if (signals.length === 0) return null;

    const allText = signals.map(s => `${s.title} ${s.summary}`).join(' ');
    const services = this.extractServices(allText);
    const errors = this.extractErrors(allText);
    const severity = this.classifySeverity(allText, signals);

    // Build the incident title from the most relevant signal
    const primarySignal = signals[0];
    const title = primarySignal.title.length > 10
      ? primarySignal.title
      : `Detected anomaly in ${services.join(', ') || 'unknown service'}`;

    const incident: Incident = {
      id: uuid(),
      title: title.substring(0, 200),
      summary: this.buildSummary(signals),
      severity,
      detectedAt: primarySignal.timestamp,
      services,
      errors,
      rootCause: this.inferRootCause(allText, errors),
      signals,
      remediationActions: [],
    };

    console.log(`[analyzer] Created incident: ${incident.id} [${severity}] — ${incident.title}`);
    return incident;
  }

  private extractServices(text: string): string[] {
    const lower = text.toLowerCase();
    return KNOWN_SERVICES.filter(svc => lower.includes(svc));
  }

  private extractErrors(text: string): string[] {
    const errors = new Set<string>();
    for (const pattern of ERROR_PATTERNS) {
      const matches = text.match(pattern);
      if (matches) {
        for (const m of matches) errors.add(m);
      }
    }
    return Array.from(errors);
  }

  private classifySeverity(text: string, signals: DetectionSignal[]): Severity {
    const lower = text.toLowerCase();

    // Render health issues are always at least warning
    const hasRenderHealth = signals.some(s => s.source === 'render_health');

    if (CRITICAL_KEYWORDS.some(kw => lower.includes(kw))) return 'critical';
    if (hasRenderHealth) return 'warning';
    if (WARNING_KEYWORDS.some(kw => lower.includes(kw))) return 'warning';
    return 'info';
  }

  private inferRootCause(text: string, errors: string[]): string | undefined {
    const lower = text.toLowerCase();

    if (errors.some(e => e.match(/5\d{2}/))) return 'Server-side error detected';
    if (lower.includes('timeout') || lower.includes('ETIMEDOUT')) return 'Service timeout';
    if (lower.includes('oom') || lower.includes('out of memory')) return 'Resource exhaustion (memory)';
    if (lower.includes('disk') || lower.includes('ENOSPC')) return 'Resource exhaustion (disk)';
    if (lower.includes('dns')) return 'DNS resolution failure';
    if (lower.includes('certificate') || lower.includes('ssl') || lower.includes('tls')) return 'TLS/SSL certificate issue';
    if (lower.includes('deploy') || lower.includes('rollback')) return 'Bad deployment';

    return undefined;
  }

  private buildSummary(signals: DetectionSignal[]): string {
    const parts = signals.map(s => `[${s.source}] ${s.summary}`);
    return parts.join('\n').substring(0, 1000);
  }
}
