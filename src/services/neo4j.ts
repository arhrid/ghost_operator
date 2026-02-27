import neo4j, { Driver, Session } from 'neo4j-driver';
import { config } from '../config';
import { Incident, RemediationAction, PostMortem, GraphStats } from '../types';

export class Neo4jClient {
  private driver: Driver | null = null;

  connect(): void {
    try {
      this.driver = neo4j.driver(
        config.neo4j.uri,
        neo4j.auth.basic(config.neo4j.user, config.neo4j.password)
      );
      console.log('[neo4j] Connected');
    } catch (error: any) {
      console.error('[neo4j] Connection failed:', error.message);
    }
  }

  async close(): Promise<void> {
    if (this.driver) {
      await this.driver.close();
      this.driver = null;
    }
  }

  private getSession(): Session | null {
    if (!this.driver) {
      console.warn('[neo4j] Not connected');
      return null;
    }
    return this.driver.session();
  }

  async createIncident(incident: Incident): Promise<void> {
    const session = this.getSession();
    if (!session) return;
    try {
      await session.run(
        `CREATE (i:Incident {
          id: $id, title: $title, summary: $summary,
          severity: $severity, detectedAt: $detectedAt
        })`,
        {
          id: incident.id,
          title: incident.title,
          summary: incident.summary,
          severity: incident.severity,
          detectedAt: incident.detectedAt,
        }
      );

      for (const svc of incident.services) {
        await session.run(
          `MATCH (i:Incident {id: $incidentId})
           MERGE (s:Service {name: $name})
           MERGE (i)-[:AFFECTS]->(s)`,
          { incidentId: incident.id, name: svc }
        );
      }

      for (const err of incident.errors) {
        await session.run(
          `MATCH (i:Incident {id: $incidentId})
           MERGE (e:Error {code: $code})
           MERGE (i)-[:HAS_ERROR]->(e)`,
          { incidentId: incident.id, code: err }
        );
      }

      if (incident.rootCause) {
        await session.run(
          `MATCH (i:Incident {id: $incidentId})
           MERGE (r:RootCause {description: $desc})
           MERGE (i)-[:CAUSED_BY]->(r)`,
          { incidentId: incident.id, desc: incident.rootCause }
        );
      }
    } catch (error: any) {
      console.error('[neo4j] createIncident failed:', error.message);
    } finally {
      await session.close();
    }
  }

  async addRemediation(incidentId: string, action: RemediationAction): Promise<void> {
    const session = this.getSession();
    if (!session) return;
    try {
      await session.run(
        `MATCH (i:Incident {id: $incidentId})
         CREATE (a:Remediation {
           id: $id, type: $type, targetService: $target,
           description: $desc, executedAt: $at, success: $success
         })
         MERGE (i)-[:REMEDIATED_BY]->(a)`,
        {
          incidentId,
          id: action.id,
          type: action.type,
          target: action.targetService,
          desc: action.description,
          at: action.executedAt,
          success: action.success,
        }
      );
    } catch (error: any) {
      console.error('[neo4j] addRemediation failed:', error.message);
    } finally {
      await session.close();
    }
  }

  async addPostMortem(postMortem: PostMortem): Promise<void> {
    const session = this.getSession();
    if (!session) return;
    try {
      await session.run(
        `MATCH (i:Incident {id: $incidentId})
         CREATE (p:PostMortem {
           title: $title, timeline: $timeline, rootCause: $rootCause,
           impact: $impact, remediation: $remediation,
           lessonsLearned: $lessons, generatedAt: $at
         })
         MERGE (i)-[:HAS_POSTMORTEM]->(p)`,
        {
          incidentId: postMortem.incidentId,
          title: postMortem.title,
          timeline: postMortem.timeline,
          rootCause: postMortem.rootCause,
          impact: postMortem.impact,
          remediation: postMortem.remediation,
          lessons: postMortem.lessonsLearned,
          at: postMortem.generatedAt,
        }
      );
    } catch (error: any) {
      console.error('[neo4j] addPostMortem failed:', error.message);
    } finally {
      await session.close();
    }
  }

  async findSimilarIncidents(services: string[], errors: string[]): Promise<Incident[]> {
    const session = this.getSession();
    if (!session) return [];
    try {
      const result = await session.run(
        `MATCH (i:Incident)-[:AFFECTS]->(s:Service)
         WHERE s.name IN $services
         OPTIONAL MATCH (i)-[:HAS_ERROR]->(e:Error)
         OPTIONAL MATCH (i)-[:CAUSED_BY]->(r:RootCause)
         OPTIONAL MATCH (i)-[:REMEDIATED_BY]->(a:Remediation)
         RETURN i, collect(DISTINCT s.name) as services,
                collect(DISTINCT e.code) as errors,
                r.description as rootCause,
                collect(DISTINCT {type: a.type, target: a.targetService, success: a.success}) as remediations
         ORDER BY i.detectedAt DESC
         LIMIT 5`,
        { services }
      );

      return result.records.map((r) => {
        const node = r.get('i').properties;
        return {
          id: node.id,
          title: node.title,
          summary: node.summary,
          severity: node.severity,
          detectedAt: node.detectedAt,
          services: r.get('services'),
          errors: r.get('errors').filter(Boolean),
          rootCause: r.get('rootCause') ?? undefined,
          signals: [],
          remediationActions: [],
        };
      });
    } catch (error: any) {
      console.error('[neo4j] findSimilarIncidents failed:', error.message);
      return [];
    } finally {
      await session.close();
    }
  }

  async getGraphStats(): Promise<GraphStats> {
    const session = this.getSession();
    if (!session) {
      return { incidents: 0, services: 0, errors: 0, rootCauses: 0, remediations: 0, postMortems: 0 };
    }
    try {
      const result = await session.run(`
        OPTIONAL MATCH (i:Incident) WITH count(i) as incidents
        OPTIONAL MATCH (s:Service) WITH incidents, count(s) as services
        OPTIONAL MATCH (e:Error) WITH incidents, services, count(e) as errors
        OPTIONAL MATCH (r:RootCause) WITH incidents, services, errors, count(r) as rootCauses
        OPTIONAL MATCH (a:Remediation) WITH incidents, services, errors, rootCauses, count(a) as remediations
        OPTIONAL MATCH (p:PostMortem)
        RETURN incidents, services, errors, rootCauses, remediations, count(p) as postMortems
      `);
      const row = result.records[0];
      return {
        incidents: row?.get('incidents')?.toNumber?.() ?? row?.get('incidents') ?? 0,
        services: row?.get('services')?.toNumber?.() ?? row?.get('services') ?? 0,
        errors: row?.get('errors')?.toNumber?.() ?? row?.get('errors') ?? 0,
        rootCauses: row?.get('rootCauses')?.toNumber?.() ?? row?.get('rootCauses') ?? 0,
        remediations: row?.get('remediations')?.toNumber?.() ?? row?.get('remediations') ?? 0,
        postMortems: row?.get('postMortems')?.toNumber?.() ?? row?.get('postMortems') ?? 0,
      };
    } catch (error: any) {
      console.error('[neo4j] getGraphStats failed:', error.message);
      return { incidents: 0, services: 0, errors: 0, rootCauses: 0, remediations: 0, postMortems: 0 };
    } finally {
      await session.close();
    }
  }

  async getIncidentGraph(): Promise<{ nodes: any[]; edges: any[] }> {
    const session = this.getSession();
    if (!session) return { nodes: [], edges: [] };
    try {
      const result = await session.run(`
        MATCH (n)
        OPTIONAL MATCH (n)-[r]->(m)
        RETURN n, r, m
        LIMIT 200
      `);

      const nodesMap = new Map<string, any>();
      const edges: any[] = [];

      for (const record of result.records) {
        const n = record.get('n');
        const m = record.get('m');
        const rel = record.get('r');

        if (n) {
          const id = n.elementId;
          if (!nodesMap.has(id)) {
            nodesMap.set(id, {
              id,
              label: n.labels[0],
              properties: n.properties,
            });
          }
        }

        if (m) {
          const id = m.elementId;
          if (!nodesMap.has(id)) {
            nodesMap.set(id, {
              id,
              label: m.labels[0],
              properties: m.properties,
            });
          }
        }

        if (rel) {
          edges.push({
            source: n.elementId,
            target: m.elementId,
            type: rel.type,
          });
        }
      }

      return { nodes: Array.from(nodesMap.values()), edges };
    } catch (error: any) {
      console.error('[neo4j] getIncidentGraph failed:', error.message);
      return { nodes: [], edges: [] };
    } finally {
      await session.close();
    }
  }
}
