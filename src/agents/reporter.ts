import { SensoClient } from '../services/senso';
import { Neo4jClient } from '../services/neo4j';
import { Incident, PostMortem } from '../types';

export class ReporterAgent {
  private senso: SensoClient;
  private neo4j: Neo4jClient;

  constructor(neo4j: Neo4jClient) {
    this.senso = new SensoClient();
    this.neo4j = neo4j;
  }

  /** Generate a structured post-mortem from an incident */
  async generatePostMortem(incident: Incident): Promise<PostMortem> {
    const postMortem: PostMortem = {
      incidentId: incident.id,
      title: `Post-Mortem: ${incident.title}`,
      timeline: this.buildTimeline(incident),
      rootCause: incident.rootCause ?? 'Root cause under investigation',
      impact: this.buildImpact(incident),
      remediation: this.buildRemediation(incident),
      lessonsLearned: this.buildLessons(incident),
      generatedAt: new Date().toISOString(),
    };

    // Store in Senso as verified context for future learning
    const sensoId = await this.senso.storePostMortem(postMortem);
    if (sensoId) {
      console.log(`[reporter] Post-mortem stored in Senso: ${sensoId}`);
    }

    // Store in Neo4j as PostMortem node linked to incident
    await this.neo4j.addPostMortem(postMortem);

    console.log(`[reporter] Post-mortem generated for incident ${incident.id}`);
    return postMortem;
  }

  private buildTimeline(incident: Incident): string {
    const lines: string[] = [];
    lines.push(`- ${incident.detectedAt}: Incident detected`);

    for (const signal of incident.signals) {
      lines.push(`- ${signal.timestamp}: [${signal.source}] ${signal.title}`);
    }

    for (const action of incident.remediationActions) {
      lines.push(`- ${action.executedAt}: Remediation: ${action.description} (${action.success ? 'success' : 'failed'})`);
    }

    if (incident.resolvedAt) {
      lines.push(`- ${incident.resolvedAt}: Incident resolved`);
    }

    return lines.join('\n');
  }

  private buildImpact(incident: Incident): string {
    const parts: string[] = [];

    parts.push(`Severity: ${incident.severity.toUpperCase()}`);

    if (incident.services.length > 0) {
      parts.push(`Affected services: ${incident.services.join(', ')}`);
    }

    if (incident.errors.length > 0) {
      parts.push(`Error codes observed: ${incident.errors.join(', ')}`);
    }

    return parts.join('\n');
  }

  private buildRemediation(incident: Incident): string {
    if (incident.remediationActions.length === 0) {
      return 'No automated remediation was performed.';
    }

    return incident.remediationActions
      .map(a => `- [${a.type}] ${a.description} → ${a.success ? 'Success' : 'Failed'}`)
      .join('\n');
  }

  private buildLessons(incident: Incident): string {
    const lessons: string[] = [];

    if (incident.rootCause) {
      lessons.push(`Root cause identified as: ${incident.rootCause}. Ensure monitoring covers this failure mode.`);
    }

    const failedActions = incident.remediationActions.filter(a => !a.success);
    if (failedActions.length > 0) {
      lessons.push(`${failedActions.length} remediation action(s) failed. Review and improve automated recovery procedures.`);
    }

    if (incident.severity === 'critical') {
      lessons.push('Critical incident — consider adding redundancy or circuit breakers for affected services.');
    }

    if (lessons.length === 0) {
      lessons.push('Standard incident handling. Continue monitoring and refining detection rules.');
    }

    return lessons.join('\n');
  }
}
