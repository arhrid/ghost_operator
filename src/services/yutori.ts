import axios, { AxiosInstance } from 'axios';
import { config } from '../config';
import { ScoutConfig, ScoutUpdate } from '../types';

export class YutoriClient {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: config.yutori.baseUrl,
      headers: {
        'X-API-KEY': config.yutori.apiKey,
        'Content-Type': 'application/json',
      },
    });
  }

  /** Create a new scout for continuous monitoring */
  async createScout(scoutConfig: ScoutConfig): Promise<string | null> {
    try {
      const response = await this.client.post('/scouts', {
        name: scoutConfig.name,
        urls: scoutConfig.urls,
        keywords: scoutConfig.keywords,
        interval_minutes: scoutConfig.interval ?? 5,
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
      const response = await this.client.get(`/scouts/${scoutId}/updates`);
      return (response.data.updates ?? []).map((u: any) => ({
        scoutId,
        title: u.title ?? 'Untitled update',
        summary: u.summary ?? u.content ?? '',
        url: u.url,
        detectedAt: u.detected_at ?? new Date().toISOString(),
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
