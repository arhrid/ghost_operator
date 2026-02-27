import { v4 as uuid } from 'uuid';
import { RenderClient } from '../services/render';
import { Neo4jClient } from '../services/neo4j';
import { SensoClient } from '../services/senso';
import { Incident, RemediationAction } from '../types';

export class RemediatorAgent {
  private render: RenderClient;
  private neo4j: Neo4jClient;
  private senso: SensoClient;

  constructor(neo4j: Neo4jClient) {
    this.render = new RenderClient();
    this.neo4j = neo4j;
    this.senso = new SensoClient();
  }

  /** Decide and execute remediation for an incident */
  async remediate(incident: Incident): Promise<RemediationAction[]> {
    const actions: RemediationAction[] = [];

    // 1. Check past similar incidents for what worked
    const pastIncidents = await this.neo4j.findSimilarIncidents(incident.services, incident.errors);
    const pastContext = await this.senso.searchContext(incident.title);

    console.log(`[remediator] Found ${pastIncidents.length} similar past incidents, ${pastContext.length} context docs`);

    // 2. Determine remediation strategy
    if (incident.severity === 'info') {
      // Info-level: just log, no action
      const action = this.createAction('noop', 'none', 'Info-level incident, monitoring only');
      actions.push(action);
      return actions;
    }

    // 3. Check if any Render services are affected and need action
    const renderServices = await this.render.listServices();
    for (const svcName of incident.services) {
      const match = renderServices.find(
        rs => rs.name.toLowerCase().includes(svcName.toLowerCase())
      );

      if (match) {
        if (match.status === 'suspended') {
          // Resume suspended service
          const success = await this.render.resumeService(match.id);
          const action = this.createAction('restart', match.name, `Resumed suspended service: ${match.name}`, success);
          actions.push(action);
          await this.neo4j.addRemediation(incident.id, action);
        } else if (incident.severity === 'critical') {
          // Critical: restart + scale
          const restartSuccess = await this.render.restartService(match.id);
          const restartAction = this.createAction('restart', match.name, `Restarted service: ${match.name}`, restartSuccess);
          actions.push(restartAction);
          await this.neo4j.addRemediation(incident.id, restartAction);

          const scaleSuccess = await this.render.scaleService(match.id, 2);
          const scaleAction = this.createAction('scale', match.name, `Scaled ${match.name} to 2 instances`, scaleSuccess);
          actions.push(scaleAction);
          await this.neo4j.addRemediation(incident.id, scaleAction);
        } else {
          // Warning: just restart
          const success = await this.render.restartService(match.id);
          const action = this.createAction('restart', match.name, `Restarted service: ${match.name}`, success);
          actions.push(action);
          await this.neo4j.addRemediation(incident.id, action);
        }
      }
    }

    // 4. If no Render services matched, create alert action
    if (actions.length === 0) {
      const action = this.createAction(
        'alert',
        incident.services[0] ?? 'unknown',
        `Alert: ${incident.title} — no auto-remediation available`
      );
      actions.push(action);
      await this.neo4j.addRemediation(incident.id, action);
    }

    console.log(`[remediator] Executed ${actions.length} remediation action(s) for incident ${incident.id}`);
    return actions;
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
