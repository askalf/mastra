import { MockLanguageModelV2 } from '@internal/ai-sdk-v5/test';
import { describe, expect, it } from 'vitest';
import { Agent } from './index';

/**
 * Regression test for #23969: a caller-provided `abortSignal` firing during
 * `generate()` used to resolve with a synthesized processor tripwire
 * (`finishReason: 'tripwire'`, `tripwire.reason: 'Processor tripwire triggered'`,
 * `processorId: undefined`) even with no processors configured.
 *
 * The abort exit in llm-execution-step bails through the same helper as a
 * processor rejection. That helper previously hardcoded `reason: 'tripwire'`,
 * and the output layer consequently supplied a generic processor reason for an
 * abort that never involved a processor.
 */
function createAbortingModel(abortController: AbortController) {
  return new MockLanguageModelV2({
    doGenerate: async () => {
      abortController.abort(new DOMException('Caller cancelled', 'AbortError'));
      throw new DOMException('Caller cancelled', 'AbortError');
    },
    doStream: async () => {
      throw new Error('generate() must use doGenerate');
    },
  });
}

describe('agent abort is not reported as a processor tripwire (#23969)', () => {
  it('leaves tripwire unset when generate() is cancelled by the caller abortSignal', async () => {
    const abortController = new AbortController();
    const agent = new Agent({
      id: 'test-abort-tripwire-generate',
      name: 'Test Abort Tripwire Generate',
      instructions: 'You are a helpful assistant.',
      model: createAbortingModel(abortController),
    });

    let onAbortCalls = 0;
    const result = await agent.generate('Hello', {
      abortSignal: abortController.signal,
      onAbort: () => {
        onAbortCalls++;
      },
    });

    // The abort itself is still reported through the documented channel.
    expect(onAbortCalls).toBe(1);
    expect(abortController.signal.aborted).toBe(true);

    // No processor ran, so nothing may claim one blocked the response.
    expect(result.tripwire).toBeUndefined();
    expect(result.finishReason).not.toBe('tripwire');
  });
});
