import test from 'ava';
import Sinon from 'sinon';

import { createTestingModule } from '../utils';
import { ConfigModule } from '../../base/config';
import { CopilotModule } from '../../plugins/copilot';
import { ModelSelectionPolicy } from '../../plugins/copilot/runtime/model-selection-policy';
import { CopilotProviderFactory } from '../../plugins/copilot/providers/factory';
import { CopilotProviderRegistryService } from '../../plugins/copilot/providers/registry-service';

test('ModelSelectionPolicy resolveRequestedModel fallback test', async t => {
  const module = await createTestingModule({
    imports: [
      ConfigModule.override({
        copilot: {
          providers: {
            gemini: {
              apiKey: 'mock-gemini-key',
            },
          },
        },
      }),
      CopilotModule,
    ],
  });

  const modelSelection = module.get(ModelSelectionPolicy);
  const factory = module.get(CopilotProviderFactory);
  const registryService = module.get(CopilotProviderRegistryService);

  const registry = registryService.getRegistry();
  t.log('Registry defaults:', registry.defaults);
  t.log('Available provider IDs:', factory.getAvailableProviderIds(registry));

  const resolved = modelSelection.resolveRequestedModel({
    defaultModel: 'claude-sonnet-4-5@20250929',
    optionalModels: [],
  });

  t.log('Resolved model:', resolved);
  t.is(resolved.selectedModel, 'gemini-2.5-flash');

  await module.close();
});

import { resolveProviderModel } from '../../plugins/copilot/providers/provider-model-runtime';
import { CopilotProviderType } from '../../plugins/copilot/providers/types';

test('resolveProviderModel custom models mapping', t => {
  const geminiVertexModel = resolveProviderModel(
    { type: CopilotProviderType.GeminiVertex, backendKind: 'gemini_vertex' },
    'gemini-3.5-flash'
  );
  t.truthy(geminiVertexModel);
  t.is(geminiVertexModel?.id, 'gemini-3.5-flash');
  t.is(geminiVertexModel?.name, 'Gemini 3.5 Flash');
  t.is(geminiVertexModel?.canonicalKey, 'gemini-3.5-flash');

  const stepfunModel = resolveProviderModel(
    { type: CopilotProviderType.OpenAI, backendKind: 'openai_responses' },
    'stepfun-3.5'
  );
  t.truthy(stepfunModel);
  t.is(stepfunModel?.id, 'stepfun-3.5');
  t.is(stepfunModel?.name, 'StepFun 3.5');
  t.is(stepfunModel?.canonicalKey, 'stepfun-3.5');
});
