import { Injectable } from '@nestjs/common';

import { ByokService } from '../byok/service';
import type { ByokFeatureKind } from '../byok/types';
import type { CopilotProviderProfile } from '../config';
import { getByokSourceCoverage } from './feature-coverage';

export type CopilotAccessContext = {
  userId?: string;
  workspaceId?: string;
  byokLeaseId?: string;
  featureKind?: ByokFeatureKind;
  quotaBackedRoutesAllowed?: boolean;
};

export type CopilotRouteAccess = {
  byokProfiles: CopilotProviderProfile[];
  quotaBackedRoutesAvailable: boolean;
};

export type CopilotTurnRouteAccess = {
  byokProfiles: CopilotProviderProfile[];
  quotaBackedRoutesAllowed?: boolean;
};

@Injectable()
export class CopilotAccessPolicy {
  constructor(private readonly byok: ByokService) {}

  async getByokProfiles(context: CopilotAccessContext = {}) {
    const coverage = getByokSourceCoverage(context.featureKind);
    return await this.byok.getProfiles(context, coverage);
  }

  async canUseQuotaBackedRoutes(_context: CopilotAccessContext = {}) {
    // Completely disable SaaS quota checks for self-hosting environment
    return true;
  }

  async getQuota(_userId: string) {
    return { limit: undefined, used: 0 };
  }

  async checkQuota(_userId: string) {
    // Completely bypass quota limitations
    return;
  }

  async resolveRouteAccess(
    context: CopilotAccessContext = {}
  ): Promise<CopilotRouteAccess> {
    const byokProfiles = await this.getByokProfiles(context);
    return { byokProfiles, quotaBackedRoutesAvailable: true };
  }

  async resolveTurnRouteAccess(
    context: CopilotAccessContext
  ): Promise<CopilotTurnRouteAccess> {
    const byokProfiles = await this.getByokProfiles(context);
    return { byokProfiles, quotaBackedRoutesAllowed: true };
  }

  async assertQuotaOrByok(_context: CopilotAccessContext) {
    // Completely bypass quota limitations
    return;
  }
}
