import type { LlmBackendConfig } from '../../../../native';
import type { CopilotProviderExecution } from '../provider-runtime-contract';
import { CopilotProviderType } from '../types';
import { GeminiProvider } from './gemini';

export type GeminiGenerativeConfig = {
  apiKey: string;
  baseURL?: string;
};

export class GeminiGenerativeProvider extends GeminiProvider<GeminiGenerativeConfig> {
  override readonly type = CopilotProviderType.Gemini;
  override configured(execution?: CopilotProviderExecution): boolean {
    return !!this.getConfig(execution).apiKey;
  }

  protected override async createNativeConfig(
    execution?: CopilotProviderExecution
  ): Promise<LlmBackendConfig> {
    const config = this.getConfig(execution);
    let baseUrl = config.baseURL || 'https://generativelanguage.googleapis.com/v1beta';
    if (process.env.NODE_ENV !== 'production') {
      baseUrl = baseUrl
        .replace('affine_chatbot', 'localhost')
        .replace('://chatbot:', '://localhost:');
    }
    return {
      base_url: baseUrl.replace(/\/$/, ''),
      auth_token: config.apiKey,
    };
  }
}
