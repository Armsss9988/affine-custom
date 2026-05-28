import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';

import { CopilotSessionInvalidInput } from '../../../base';
import { llmResolveRequestedModelMatch } from '../../../native';
import { CopilotProviderRegistryService } from '../providers/registry-service';
import { CopilotProviderFactory } from '../providers/factory';

import { ModelOutputType } from '../providers/types';
import { resolveModel } from '../providers/provider-registry';

export type ResolveModelInput = {
  defaultModel: string;
  optionalModels?: string[] | null;
  requestedModelId?: string;
};

@Injectable()
export class ModelSelectionPolicy {
  constructor(
    private readonly registries: CopilotProviderRegistryService,
    private readonly moduleRef: ModuleRef
  ) {}

  private getRegistry() {
    return this.registries.getRegistry();
  }

  private matchRequestedModel(
    optionalModels: string[],
    requestedModelId?: string,
    defaultModel?: string
  ) {
    return llmResolveRequestedModelMatch({
      providerIds: [...this.getRegistry().profiles.keys()],
      optionalModels,
      requestedModelId,
      defaultModel,
    });
  }

  resolveRequestedModel(input: ResolveModelInput): {
    selectedModel: string;
    matchedOptionalModel: boolean;
  } {
    if (!input.defaultModel) {
      throw new CopilotSessionInvalidInput('Model is required');
    }
    const matched = this.matchRequestedModel(
      input.optionalModels ?? [],
      input.requestedModelId,
      input.defaultModel
    );
    
    const registry = this.getRegistry();
    let selectedModel = matched.selectedModel ?? input.defaultModel;
    
    // Check if the resolved model actually has any compatible providers
    const factory = this.moduleRef.get(CopilotProviderFactory, { strict: false });
    const availableProviderIds = factory.getAvailableProviderIds(registry);
    
    const resolved = resolveModel({
      registry,
      modelId: selectedModel,
      outputType: ModelOutputType.Text,
      availableProviderIds,
    });
    
    if (resolved.candidateProviderIds.length === 0) {
      const fallbackModel = registry.defaults?.text || registry.defaults?.fallback || 'gemini-2.5-flash';
      selectedModel = fallbackModel;
    }
    
    return {
      selectedModel,
      matchedOptionalModel: matched.matchedOptionalModel,
    };
  }

  matchesModelList(models: string[], modelId?: string) {
    return this.matchRequestedModel(models, modelId).matchedOptionalModel;
  }
}
