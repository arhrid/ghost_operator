import axios, { AxiosInstance } from 'axios';
import { config } from '../config';
import { RenderService } from '../types';

export class RenderClient {
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: config.render.baseUrl,
      headers: {
        Authorization: `Bearer ${config.render.apiKey}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    });
  }

  /** List all services owned by this account */
  async listServices(): Promise<RenderService[]> {
    try {
      const response = await this.client.get('/services', {
        params: { limit: 20 },
      });
      return (response.data ?? []).map((item: any) => {
        const svc = item.service ?? item;
        return {
          id: svc.id,
          name: svc.name,
          type: svc.type,
          status: svc.suspended === 'suspended' ? 'suspended' : 'active',
          url: svc.serviceDetails?.url ?? svc.url,
        };
      });
    } catch (error: any) {
      console.error('[render] listServices failed:', error.message);
      return [];
    }
  }

  /** Get the status/health of a specific service */
  async getServiceStatus(serviceId: string): Promise<{ status: string; lastDeploy?: string } | null> {
    try {
      const response = await this.client.get(`/services/${serviceId}`);
      const svc = response.data;
      return {
        status: svc.suspended === 'suspended' ? 'suspended' : 'active',
        lastDeploy: svc.updatedAt,
      };
    } catch (error: any) {
      console.error('[render] getServiceStatus failed:', error.message);
      return null;
    }
  }

  /** Restart a service by triggering a new deploy */
  async restartService(serviceId: string): Promise<boolean> {
    try {
      await this.client.post(`/services/${serviceId}/deploys`);
      console.log(`[render] Restarted service ${serviceId}`);
      return true;
    } catch (error: any) {
      console.error('[render] restartService failed:', error.message);
      return false;
    }
  }

  /** Scale a service (change instance count) */
  async scaleService(serviceId: string, numInstances: number): Promise<boolean> {
    try {
      await this.client.patch(`/services/${serviceId}`, {
        serviceDetails: { numInstances },
      });
      console.log(`[render] Scaled service ${serviceId} to ${numInstances} instances`);
      return true;
    } catch (error: any) {
      console.error('[render] scaleService failed:', error.message);
      return false;
    }
  }

  /** Resume a suspended service */
  async resumeService(serviceId: string): Promise<boolean> {
    try {
      await this.client.post(`/services/${serviceId}/resume`);
      console.log(`[render] Resumed service ${serviceId}`);
      return true;
    } catch (error: any) {
      console.error('[render] resumeService failed:', error.message);
      return false;
    }
  }
}
