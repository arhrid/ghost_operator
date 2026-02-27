function env(key: string, fallback?: string): string {
  const value = process.env[key] ?? fallback;
  if (!value) {
    console.warn(`[config] Missing env var: ${key}`);
    return '';
  }
  return value;
}

export const config = {
  port: parseInt(env('PORT', '3000'), 10),

  tavily: {
    apiKey: env('TAVILY_API_KEY'),
    baseUrl: 'https://api.tavily.com',
  },

  yutori: {
    apiKey: env('YUTORI_API_KEY'),
    baseUrl: 'https://api.yutori.com/v1',
  },

  neo4j: {
    uri: env('NEO4J_URI', 'bolt://localhost:7687'),
    user: env('NEO4J_USER', 'neo4j'),
    password: env('NEO4J_PASSWORD', 'password'),
    database: env('NEO4J_DATABASE', 'neo4j'),
  },

  render: {
    apiKey: env('RENDER_API_KEY'),
    baseUrl: 'https://api.render.com/v1',
  },

  senso: {
    apiKey: env('SENSO_API_KEY'),
    organizationId: env('SENSO_ORGANIZATION_ID'),
    baseUrl: 'https://api.senso.ai/v1',
  },

  // Detection loop interval in seconds
  detectionIntervalSec: 60,
};
