import { llmResolveModelRegistryVariant } from '../packages/backend/server/src/native';

try {
  const res = llmResolveModelRegistryVariant({
    modelId: 'step-1-8k',
  });
  console.log('step-1-8k:', !!res.variant);
} catch (e) {}

try {
  const res = llmResolveModelRegistryVariant({
    modelId: 'stepfun-3.5-flash',
  });
  console.log('stepfun-3.5-flash:', !!res.variant);
} catch (e) {}

try {
  const res = llmResolveModelRegistryVariant({
    modelId: 'step-3.5-flash',
  });
  console.log('step-3.5-flash:', !!res.variant);
} catch (e) {}
