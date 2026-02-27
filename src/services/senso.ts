import axios, { AxiosInstance } from 'axios';
import { config } from '../config';
import { PostMortem } from '../types';

export class SensoClient {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: config.senso.baseUrl,
      headers: {
        Authorization: `Bearer ${config.senso.apiKey}`,
        'Content-Type': 'application/json',
        'X-Organization-Id': config.senso.organizationId,
      },
    });
  }

  /** Store a post-mortem as verified context in Senso */
  async storePostMortem(postMortem: PostMortem): Promise<string | null> {
    try {
      const document = {
        title: postMortem.title,
        content: [
          `# ${postMortem.title}`,
          '',
          `## Timeline`,
          postMortem.timeline,
          '',
          `## Root Cause`,
          postMortem.rootCause,
          '',
          `## Impact`,
          postMortem.impact,
          '',
          `## Remediation`,
          postMortem.remediation,
          '',
          `## Lessons Learned`,
          postMortem.lessonsLearned,
        ].join('\n'),
        metadata: {
          type: 'post-mortem',
          incidentId: postMortem.incidentId,
          generatedAt: postMortem.generatedAt,
          source: 'ghost-operator',
        },
      };

      const response = await this.client.post('/documents', document);
      const docId = response.data.id ?? response.data.document_id;
      console.log(`[senso] Post-mortem stored: ${docId}`);
      return docId;
    } catch (error: any) {
      console.error('[senso] storePostMortem failed:', error.message);
      return null;
    }
  }

  /** Search for past context/learnings relevant to a query */
  async searchContext(query: string, limit = 5): Promise<Array<{ title: string; content: string; score: number }>> {
    try {
      const response = await this.client.post('/search', {
        query,
        limit,
        filters: { type: 'post-mortem' },
      });

      return (response.data.results ?? []).map((r: any) => ({
        title: r.title ?? 'Untitled',
        content: r.content ?? r.snippet ?? '',
        score: r.score ?? 0,
      }));
    } catch (error: any) {
      console.error('[senso] searchContext failed:', error.message);
      return [];
    }
  }
}
