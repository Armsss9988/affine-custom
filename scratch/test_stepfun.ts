import { llmResolveModelRegistryVariant } from '../packages/backend/server/src/native';

const modelsToTest = [
  'step-1-8k',
  'step-1.5v-mini',
  'step-2-16k',
  'stepfun-3.5-flash'
];

async function test() {
  for (const modelId of modelsToTest) {
    try {
      const res = llmResolveModelRegistryVariant({
        backendKind: 'openai_chat',
        modelId: modelId,
      });
      console.log(`${modelId} resolve result:`, res.variant ? 'FOUND' : 'NOT FOUND');
    } catch (e) {
      console.log(`${modelId} error:`, e.message);
    }
  }
}

test();
