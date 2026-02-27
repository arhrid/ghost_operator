import { v4 as uuid } from 'uuid';
import { RenderClient } from '../services/render';
import { Neo4jClient } from '../services/neo4j';
import { SensoClient } from '../services/senso';
import { TavilyClient } from '../services/tavily';
import { Incident, RemediationAction, PastRemediation } from '../types';

export class RemediatorAgent {
  private render: RenderClient;
  private neo4j: Neo4jClient;
  private senso: SensoClient;
  private tavily: TavilyClient;

  constructor(neo4j: Neo4jClient) {
    this.render = new RenderClient();
    this.neo4j = neo4j;
    this.senso = new SensoClient();
    this.tavily = new TavilyClient();
  }

  /** Decide and execute remediation for an incident */
  async remediate(incident: Incident): Promise<RemediationAction[]> {
    const actions: RemediationAction[] = [];

    // 1. Check past similar incidents for what worked
    const pastResults = await this.neo4j.findSimilarIncidents(incident.services, incident.errors);
    const pastContext = await this.senso.searchContext(incident.title);

    // 2. Search Tavily for remediation guidance
    const tavilyContext = await this.tavily.searchRemediation(
      incident.errors[0] ?? incident.rootCause ?? incident.title
    );

    console.log(`[remediator] Found ${pastResults.length} similar past incidents, ${pastContext.length} context docs`);

    // 3. Analyze past remediation outcomes
    const allPastRemediations = pastResults.flatMap(r => r.remediations);
    const pastAnalysis = this.analyzePastRemediations(allPastRemediations);

    // 4. Extract guidance keywords from Senso post-mortems
    const sensoGuidance = this.extractSensoGuidance(pastContext);

    // 5. Determine remediation strategy
    if (incident.severity === 'info') {
      const action = this.createAction('noop', 'none', 'Info-level incident, monitoring only');
      action.reasoning = 'Severity is info — no remediation needed, monitoring only.';
      actions.push(action);
      return actions;
    }

    // 6. Check if any Render services are affected and need action
    const renderServices = await this.render.listServices();
    for (const svcName of incident.services) {
      const match = renderServices.find(
        rs => rs.name.toLowerCase().includes(svcName.toLowerCase())
      );

      if (match) {
        if (match.status === 'suspended') {
          const success = await this.render.resumeService(match.id);
          const action = this.createAction('restart', match.name, `Resumed suspended service: ${match.name}`, success);
          action.reasoning = `Service ${match.name} was suspended. Resuming to restore availability.`;
          actions.push(action);
          await this.neo4j.addRemediation(incident.id, action);
        } else if (this.shouldEscalate(incident, pastAnalysis, sensoGuidance)) {
          // Past data says simple restarts failed — escalate to restart+scale
          const restartSuccess = await this.render.restartService(match.id);
          const restartAction = this.createAction('restart', match.name, `Restarted service: ${match.name}`, restartSuccess);
          restartAction.reasoning = this.buildEscalationReasoning(pastAnalysis, sensoGuidance, tavilyContext);
          actions.push(restartAction);
          await this.neo4j.addRemediation(incident.id, restartAction);

          const scaleSuccess = await this.render.scaleService(match.id, 2);
          const scaleAction = this.createAction('scale', match.name, `Scaled ${match.name} to 2 instances`, scaleSuccess);
          scaleAction.reasoning = `Scaling to 2 instances for resilience. ${pastAnalysis.restartFailRate > 0 ? `Past restart-only attempts failed ${Math.round(pastAnalysis.restartFailRate * 100)}% of the time.` : ''}`;
          actions.push(scaleAction);
          await this.neo4j.addRemediation(incident.id, scaleAction);
        } else if (incident.severity === 'critical') {
          const restartSuccess = await this.render.restartService(match.id);
          const restartAction = this.createAction('restart', match.name, `Restarted service: ${match.name}`, restartSuccess);
          restartAction.reasoning = `Critical severity with no prior failure history for restarts. Restarting ${match.name}.`;
          actions.push(restartAction);
          await this.neo4j.addRemediation(incident.id, restartAction);

          const scaleSuccess = await this.render.scaleService(match.id, 2);
          const scaleAction = this.createAction('scale', match.name, `Scaled ${match.name} to 2 instances`, scaleSuccess);
          scaleAction.reasoning = 'Critical incident — scaling for redundancy as standard critical protocol.';
          actions.push(scaleAction);
          await this.neo4j.addRemediation(incident.id, scaleAction);
        } else {
          const success = await this.render.restartService(match.id);
          const action = this.createAction('restart', match.name, `Restarted service: ${match.name}`, success);
          action.reasoning = pastResults.length > 0
            ? `Warning severity. Past restarts for similar incidents succeeded — applying same strategy.`
            : `Warning severity. Restarting ${match.name} as standard first response.`;
          actions.push(action);
          await this.neo4j.addRemediation(incident.id, action);
        }
      }
    }

    // 7. If no Render services matched, create alert action
    if (actions.length === 0) {
      const action = this.createAction(
        'alert',
        incident.services[0] ?? 'unknown',
        `Alert: ${incident.title} — no auto-remediation available`
      );
      action.reasoning = tavilyContext
        ? `No matching Render services. Tavily suggests: ${tavilyContext.substring(0, 200)}`
        : 'No matching Render services found for auto-remediation. Alerting for manual review.';
      actions.push(action);
      await this.neo4j.addRemediation(incident.id, action);
    }

    console.log(`[remediator] Executed ${actions.length} remediation action(s) for incident ${incident.id}`);
    return actions;
  }

  /** Validate that remediation worked by re-checking service health */
  async validateRemediation(incident: Incident): Promise<{ healthy: boolean; retried: boolean }> {
    // Wait before re-checking
    await new Promise(resolve => setTimeout(resolve, 10_000));

    const renderServices = await this.render.listServices();
    let allHealthy = true;
    let retried = false;

    for (const action of incident.remediationActions) {
      if (action.type === 'noop' || action.type === 'alert') continue;

      const match = renderServices.find(
        rs => rs.name.toLowerCase().includes(action.targetService.toLowerCase())
      );

      if (match) {
        const status = await this.render.getServiceStatus(match.id);
        const isHealthy = status?.status === 'active';
        action.validated = isHealthy;
        await this.neo4j.updateRemediationValidation(action.id, isHealthy);

        if (!isHealthy) {
          allHealthy = false;
          // Escalate: if we only restarted, try scaling; if we scaled, alert
          if (action.type === 'restart') {
            console.log(`[remediator] Restart of ${match.name} didn't resolve — escalating to scale`);
            const scaleSuccess = await this.render.scaleService(match.id, 2);
            const scaleAction = this.createAction('scale', match.name, `Escalation: scaled ${match.name} to 2 instances after restart failed`, scaleSuccess);
            scaleAction.reasoning = 'Validation failed after restart. Escalating to scale for additional capacity.';
            incident.remediationActions.push(scaleAction);
            await this.neo4j.addRemediation(incident.id, scaleAction);
            retried = true;
          } else if (action.type === 'scale') {
            console.log(`[remediator] Scale of ${match.name} didn't resolve — escalating to alert`);
            const alertAction = this.createAction('alert', match.name, `Escalation: ${match.name} still unhealthy after scale — requires manual intervention`);
            alertAction.reasoning = 'Validation failed after scaling. Escalating to manual alert.';
            incident.remediationActions.push(alertAction);
            await this.neo4j.addRemediation(incident.id, alertAction);
            retried = true;
          }
        }
      }
    }

    if (allHealthy) {
      incident.resolvedAt = new Date().toISOString();
    }

    return { healthy: allHealthy, retried };
  }

  private analyzePastRemediations(remediations: PastRemediation[]): {
    restartFailRate: number;
    scaleSuccessRate: number;
    hadFailedRestarts: boolean;
  } {
    const restarts = remediations.filter(r => r.type === 'restart');
    const scales = remediations.filter(r => r.type === 'scale');
    const failedRestarts = restarts.filter(r => !r.success);

    return {
      restartFailRate: restarts.length > 0 ? failedRestarts.length / restarts.length : 0,
      scaleSuccessRate: scales.length > 0 ? scales.filter(r => r.success).length / scales.length : 0,
      hadFailedRestarts: failedRestarts.length > 0,
    };
  }

  private extractSensoGuidance(pastContext: Array<{ title: string; content: string; score: number }>): string[] {
    const guidance: string[] = [];
    const escalationKeywords = ['scale', 'escalat', 'capacity', 'insufficient', 'restart failed', 'restart alone'];

    for (const doc of pastContext) {
      const lower = doc.content.toLowerCase();
      for (const kw of escalationKeywords) {
        if (lower.includes(kw)) {
          guidance.push(`Senso post-mortem "${doc.title}" suggests: ${kw}`);
          break;
        }
      }
    }
    return guidance;
  }

  private shouldEscalate(
    incident: Incident,
    pastAnalysis: { restartFailRate: number; hadFailedRestarts: boolean },
    sensoGuidance: string[]
  ): boolean {
    // Escalate if: warning severity but past restarts failed, or Senso docs suggest escalation
    if (incident.severity === 'warning' && pastAnalysis.hadFailedRestarts) return true;
    if (incident.severity === 'warning' && sensoGuidance.length > 0) return true;
    return false;
  }

  private buildEscalationReasoning(
    pastAnalysis: { restartFailRate: number; hadFailedRestarts: boolean },
    sensoGuidance: string[],
    tavilyContext: string | null
  ): string {
    const parts: string[] = ['Escalated from restart-only to restart+scale based on:'];
    if (pastAnalysis.hadFailedRestarts) {
      parts.push(`- Neo4j: past restarts failed ${Math.round(pastAnalysis.restartFailRate * 100)}% of the time for similar incidents`);
    }
    if (sensoGuidance.length > 0) {
      parts.push(`- Senso: ${sensoGuidance[0]}`);
    }
    if (tavilyContext) {
      parts.push(`- Tavily: ${tavilyContext.substring(0, 150)}`);
    }
    return parts.join('\n');
  }

  private createAction(
    type: RemediationAction['type'],
    target: string,
    description: string,
    success = true
  ): RemediationAction {
    return {
      id: uuid(),
      type,
      targetService: target,
      description,
      executedAt: new Date().toISOString(),
      success,
    };
  }
}
