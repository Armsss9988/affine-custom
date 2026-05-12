/**
 * @vitest-environment happy-dom
 */
import { describe, expect, test, vi } from 'vitest';

import { AIChatInput } from './ai-chat-input';

function createChatContext() {
  return {
    messages: [],
    status: 'idle' as const,
    error: null,
    quote: '',
    markdown: '',
    images: [],
    abortController: null,
    snapshot: null,
    combinedElementsMarkdown: null,
    attachments: [],
    docs: [],
    html: null,
  };
}

describe('AIChatInput background agent submit', () => {
  test('background handler enqueues without creating a chat session', async () => {
    const event = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const createSession = vi.fn();
    const setDraft = vi.fn().mockResolvedValue(undefined);
    const input = {
      textarea: {
        value: 'write a background plan',
        style: {
          height: '20px',
        },
      },
      isInputEmpty: false,
      chatContextValue: createChatContext(),
      onEnqueueAgentJob: enqueue,
      createSession,
      aiDraftService: {
        setDraft,
      },
    };

    await (AIChatInput.prototype as any)._onBackgroundAgentSend.call(
      input,
      event
    );

    expect(event.preventDefault).toHaveBeenCalled();
    expect(event.stopPropagation).toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith({
      text: 'write a background plan',
      chatContextValue: expect.objectContaining({
        status: 'idle',
      }),
    });
    expect(setDraft).toHaveBeenCalledWith({ input: '' });
    expect(input.textarea.value).toBe('');
    expect(input.isInputEmpty).toBe(true);
    expect(createSession).not.toHaveBeenCalled();
  });
});
