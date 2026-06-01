import type { LlmBackendConfig } from '../../../../native';
import type { CopilotProviderExecution } from '../provider-runtime-contract';
import { CopilotProviderType } from '../types';
import { getGoogleAuth, type VertexProviderConfig } from '../utils';
import { GeminiProvider } from './gemini';

export type GeminiVertexConfig = VertexProviderConfig;

export class GeminiVertexProvider extends GeminiProvider<GeminiVertexConfig> {
  override readonly type = CopilotProviderType.GeminiVertex;
  override configured(execution?: CopilotProviderExecution): boolean {
    const config = this.getConfig(execution);
    const location = config.location || process.env.VERTEX_LOCATION;
    const googleAuthOptions =
      config.googleAuthOptions || process.env.VERTEX_AUTH_TOKEN;
    const clientEmail = process.env.VERTEX_CLIENT_EMAIL;
    const privateKey = process.env.VERTEX_PRIVATE_KEY;
    const project = config.project || process.env.VERTEX_PROJECT;

    return (
      !!location &&
      (!!googleAuthOptions || (!!clientEmail && !!privateKey && !!project))
    );
  }

  protected async resolveVertexAuth(execution?: CopilotProviderExecution) {
    const config = this.getConfig(execution);
    const location = config.location || process.env.VERTEX_LOCATION;
    const project = config.project || process.env.VERTEX_PROJECT;
    let googleAuthOptions =
      config.googleAuthOptions || process.env.VERTEX_AUTH_TOKEN;

    if (
      !googleAuthOptions &&
      process.env.VERTEX_CLIENT_EMAIL &&
      process.env.VERTEX_PRIVATE_KEY
    ) {
      googleAuthOptions = {
        credentials: {
          client_email: process.env.VERTEX_CLIENT_EMAIL,
          private_key: process.env.VERTEX_PRIVATE_KEY.replace(/\\n/g, '\n'),
        },
      };
    }

    return await getGoogleAuth(
      {
        ...config,
        location,
        project,
        googleAuthOptions,
      },
      'google'
    );
  }

  protected override async createNativeConfig(
    execution?: CopilotProviderExecution
  ): Promise<LlmBackendConfig> {
    const auth = await this.resolveVertexAuth(execution);
    const { Authorization: authHeader } = auth.headers();

    return {
      base_url: auth.baseUrl || '',
      auth_token: authHeader.replace(/^Bearer\s+/i, ''),
    };
  }
}
