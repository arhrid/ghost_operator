import { TavilyClient } from '../services/tavily';
import { YutoriClient } from '../services/yutori';
import { RenderClient } from '../services/render';
import { DetectionSignal } from '../types';

export class DetectorAgent {
  private tavily: TavilyClient;
  private yutori: YutoriClient;
  private render: RenderClient;
  private scoutIds: string[] = [];

  constructor() {
    this.tavily = new TavilyClient();
    this.yutori = new YutoriClient();
    this.render = new RenderClient();
  }

  /** Initialize Yutori scouts for continuous monitoring */
  async initScouts(): Promise<void> {
    const scouts = [
      {
        name: 'cloud-status',
        urls: [
          'https://status.aws.amazon.com',
          'https://status.cloud.google.com',
          'https://status.azure.com',
          'https://www.render.com/status',
        ],
        keywords: ['outage', 'degraded', 'incident', 'disruption', 'unavailable'],
        interval: 5,
      },
      {
        name: 'community-alerts',
        urls: [
          'https://www.reddit.com/r/devops/new',
          'https://news.ycombinator.com/newest',
          'https://www.reddit.com/r/sysadmin/new',
        ],
        keywords: ['outage', 'down', 'incident', '503', '500', 'degraded'],
        interval: 5,
      },
    ];

    for (const scout of scouts) {
      const id = await this.yutori.createScout(scout);
      if (id) this.scoutIds.push(id);
    }
    console.log(`[detector] Initialized ${this.scoutIds.length} scouts`);
  }

  /** Run a single detection cycle, returning any signals found */
  async detect(): Promise<DetectionSignal[]> {
    const signals: DetectionSignal[] = [];
    const now = new Date().toISOString();

    // 1. Check Render services health
    const renderSignals = await this.checkRenderHealth();
    signals.push(...renderSignals);

    // 2. Search for outage reports via Tavily
    const tavilySignals = await this.searchOutages();
    signals.push(...tavilySignals);

    // 3. Check Yutori scout updates
    const yutoriSignals = await this.checkScoutUpdates();
    signals.push(...yutoriSignals);

    if (signals.length > 0) {
      console.log(`[detector] Found ${signals.length} signal(s)`);
    }

    return signals;
  }

  private async checkRenderHealth(): Promise<DetectionSignal[]> {
    const signals: DetectionSignal[] = [];
    try {
      const services = await this.render.listServices();
      for (const svc of services) {
        if (svc.status === 'suspended' || svc.status !== 'active') {
          signals.push({
            source: 'render_health',
            title: `Service unhealthy: ${svc.name}`,
            summary: `Render service "${svc.name}" (${svc.id}) is ${svc.status}`,
            timestamp: new Date().toISOString(),
            raw: svc,
          });
        }
      }
    } catch (error: any) {
      console.error('[detector] Render health check failed:', error.message);
    }
    return signals;
  }

  private async searchOutages(): Promise<DetectionSignal[]> {
    const signals: DetectionSignal[] = [];

    // Run general outage search + targeted per-service searches in parallel
    const searches: Promise<void>[] = [];

    // General outage search
    searches.push(
      this.tavily.searchOutages().then(results => {
        for (const r of results.results) {
          if (r.score > 0.5) {
            signals.push({
              source: 'tavily',
              title: r.title,
              summary: r.content.substring(0, 500),
              url: r.url,
              timestamp: new Date().toISOString(),
              raw: r,
            });
          }
        }
      }).catch((error: any) => {
        console.error('[detector] Tavily general search failed:', error.message);
      })
    );

    // Targeted searches for active Render services
    try {
      const renderServices = await this.render.listServices();
      for (const svc of renderServices.slice(0, 2)) {
        searches.push(
          this.tavily.searchOutages(svc.name).then(results => {
            for (const r of results.results) {
              if (r.score > 0.6) {
                signals.push({
                  source: 'tavily',
                  title: r.title,
                  summary: r.content.substring(0, 500),
                  url: r.url,
                  timestamp: new Date().toISOString(),
                  raw: r,
                });
              }
            }
          }).catch((error: any) => {
            console.error(`[detector] Tavily search for ${svc.name} failed:`, error.message);
          })
        );
      }
    } catch (error: any) {
      console.error('[detector] Failed to get Render services for targeted search:', error.message);
    }

    await Promise.all(searches);

    // Deduplicate by URL
    const seen = new Set<string>();
    return signals.filter(s => {
      if (s.url && seen.has(s.url)) return false;
      if (s.url) seen.add(s.url);
      return true;
    });
  }

  private async checkScoutUpdates(): Promise<DetectionSignal[]> {
    const signals: DetectionSignal[] = [];
    for (const scoutId of this.scoutIds) {
      try {
        const updates = await this.yutori.getUpdates(scoutId);
        for (const update of updates) {
          signals.push({
            source: 'yutori',
            title: update.title,
            summary: update.summary,
            url: update.url,
            timestamp: update.detectedAt,
            raw: update,
          });
        }
      } catch (error: any) {
        console.error(`[detector] Yutori scout ${scoutId} check failed:`, error.message);
      }
    }
    return signals;
  }
}
