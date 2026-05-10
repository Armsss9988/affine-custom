import { describe, expect, test } from 'vitest';

import { parsePlanningResponse } from './agent-planner';

describe('parsePlanningResponse', () => {
  test('preserves planner params as executable tool input', () => {
    const steps = parsePlanningResponse(
      JSON.stringify([
        {
          toolName: 'affine.create_doc_from_markdown',
          params: {
            title: 'Architecture Notes',
            markdown: '# Architecture Notes',
          },
        },
      ])
    );

    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      toolName: 'affine.create_doc_from_markdown',
      toolInput: {
        title: 'Architecture Notes',
        markdown: '# Architecture Notes',
      },
      toolInputPreview: {
        title: 'Architecture Notes',
        markdown: '# Architecture Notes',
      },
      status: 'pending',
    });
  });
});
