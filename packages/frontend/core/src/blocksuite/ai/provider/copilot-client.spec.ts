/**
 * @vitest-environment happy-dom
 */
import { describe, expect, test, vi } from 'vitest';

import { CopilotClient, Endpoint } from './copilot-client';

describe('CopilotClient chat tools config', () => {
  test('enables web search by default for chat streams', () => {
    const eventSource = vi.fn(
      () =>
        ({
          close: vi.fn(),
        }) as unknown as EventSource
    );
    const client = new CopilotClient(vi.fn(), eventSource);

    client.chatTextStream({
      sessionId: 'session-1',
      messageId: 'message-1',
    });

    expect(eventSource).toHaveBeenCalledWith(
      '/api/copilot/chat/session-1/stream-object?messageId=message-1&webSearch=true'
    );
  });

  test('keeps web search as a top-level query param when other tool config is sent', () => {
    const eventSource = vi.fn(
      () =>
        ({
          close: vi.fn(),
        }) as unknown as EventSource
    );
    const client = new CopilotClient(vi.fn(), eventSource);

    client.chatTextStream({
      sessionId: 'session-1',
      toolsConfig: {
        searchWorkspace: false,
        readingDocs: true,
        webSearch: true,
      },
    });

    expect(eventSource).toHaveBeenCalledWith(
      '/api/copilot/chat/session-1/stream-object?toolsConfig=%7B%22searchWorkspace%22%3Afalse%2C%22readingDocs%22%3Atrue%7D&webSearch=true'
    );
  });

  test('allows explicit web search disable for chat streams', () => {
    const eventSource = vi.fn(
      () =>
        ({
          close: vi.fn(),
        }) as unknown as EventSource
    );
    const client = new CopilotClient(vi.fn(), eventSource);

    client.chatTextStream({
      sessionId: 'session-1',
      toolsConfig: {
        webSearch: false,
      },
    });

    expect(eventSource).toHaveBeenCalledWith(
      '/api/copilot/chat/session-1/stream-object'
    );
  });
});

describe('CopilotClient action streams', () => {
  test('routes action endpoint outside the deprecated workflow path', () => {
    const eventSource = vi.fn(
      () =>
        ({
          close: vi.fn(),
        }) as unknown as EventSource
    );
    const client = new CopilotClient(vi.fn(), eventSource);

    client.chatTextStream(
      {
        sessionId: 'session-1',
        messageId: 'message-1',
        actionId: 'mindmap.generate',
        actionVersion: 'v1',
        retry: true,
        runId: 'run-1',
      },
      Endpoint.Action
    );

    expect(eventSource).toHaveBeenCalledWith(
      '/api/copilot/actions/session-1/stream?messageId=message-1&actionId=mindmap.generate&actionVersion=v1&runId=run-1&retry=true'
    );
  });
});
