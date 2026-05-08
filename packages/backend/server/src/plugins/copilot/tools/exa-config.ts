import type { Config } from '../../../base';

const PLACEHOLDER_KEYS = new Set(['your_exa_api_key']);

export function getConfiguredExaKey(config: Config) {
  const key = config.copilot?.exa?.key?.trim();
  if (!key) {
    return;
  }

  if (PLACEHOLDER_KEYS.has(key.toLowerCase())) {
    return;
  }

  return key;
}
