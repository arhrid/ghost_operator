import axios from 'axios';
import { config } from '../config';

export interface TavilySearchResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

export interface TavilySearchResponse {
  query: string;
  results: TavilySearchResult[];
  answer?: string;
}

export class TavilyClient {
  private apiKey: string;
  private baseUrl: string;

  constructor() {
    this.apiKey = config.tavily.apiKey;
    this.baseUrl = config.tavily.baseUrl;
  }

  async search(query: string, maxResults = 5): Promise<TavilySearchResponse> {
    try {
      const response = await axios.post(`${this.baseUrl}/search`, {
        api_key: this.apiKey,
        query,
        max_results: maxResults,
        search_depth: 'basic',
        include_answer: true,
      });

      return {
        query,
        results: (response.data.results ?? []).map((r: any) => ({
          title: r.title,
          url: r.url,
          content: r.content,
          score: r.score,
        })),
        answer: response.data.answer,
      };
    } catch (error: any) {
      console.error('[tavily] Search failed:', error.message);
      return { query, results: [] };
    }
  }

  /** Convenience: search for outage/incident reports */
  async searchOutages(serviceName?: string): Promise<TavilySearchResponse> {
    const query = serviceName
      ? `${serviceName} outage OR incident OR down today`
      : 'major cloud service outage OR incident today';
    return this.search(query);
  }
}
