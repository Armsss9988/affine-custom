import { llmResolveModelRegistryVariant } from '../packages/backend/server/src/native';
// Since there's no list function, we can't easily list them all from Node.
// But we can test common ones.
const common = [
  'gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo',
  'claude-3-5-sonnet', 'claude-3-opus',
  'gemini-1.5-pro', 'gemini-1.5-flash',
  'llama-3-70b-instruct', 'mixtral-8x7b-instruct'
];

for (const m of common) {
  const res = llmResolveModelRegistryVariant({ modelId: m });
  if (res.variant) {
    console.log(`- ${m}`);
  }
}
