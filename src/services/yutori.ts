import axios, { AxiosInstance } from 'axios';
import { config } from '../config';
import { ScoutConfig, ScoutUpdate } from '../types';

export class YutoriClient {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: config.yutori.baseUrl,
      headers: {
        'X-API-Key': config.yutori.apiKey,
        'Content-Type': 'application/json',
      },
    });
  }

  /** Create a new scout for continuous monitoring */
  async createScout(scoutConfig: ScoutConfig): Promise<string | null> {
    try {
      const response = await this.client.post('/scouting/tasks', {
        query: scoutConfig.query,
        output_interval: scoutConfig.intervalSeconds ?? 1800,
        skip_email: true,
      });
      console.log(`[yutori] Scout created: ${response.data.id}`);
      return response.data.id;
    } catch (error: any) {
      console.error('[yutori] Failed to create scout:', error.message);
      return null;
    }
  }

  /** Get latest updates from a scout */
  async getUpdates(scoutId: string): Promise<ScoutUpdate[]> {
    try {
      const response = await this.client.get(`/scouting/tasks/${scoutId}/updates`);
      return (response.data.updates ?? []).map((u: any) => ({
        scoutId,
        title: extractTitle(u.content) ?? 'Untitled update',
        summary: stripHtml(u.content ?? ''),
        url: u.citations?.[0]?.url,
        detectedAt: u.timestamp ? new Date(u.timestamp).toISOString() : new Date().toISOString(),
      }));
    } catch (error: any) {
      console.error('[yutori] Failed to get updates:', error.message);
      return [];
    }
  }

  /** Deep web research on a topic */
  async research(query: string): Promise<{ summary: string; sources: string[] }> {
    try {
      const response = await this.client.post('/research', { query });
      return {
        summary: response.data.summary ?? '',
        sources: response.data.sources ?? [],
      };
    } catch (error: any) {
      console.error('[yutori] Research failed:', error.message);
      return { summary: '', sources: [] };
    }
  }
}

/** Extract first h3 text from HTML content as a title */
function extractTitle(html: string): string | null {
  const match = html?.match(/<h3>(.*?)<\/h3>/);
  return match ? match[1] : null;
}

/** Strip HTML tags for plain-text summary */
function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
}
