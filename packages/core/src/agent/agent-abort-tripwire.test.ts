import { convertArrayToReadableStream, MockLanguageModelV2 } from '@internal/ai-sdk-v5/test';
import { describe, expect, it } from 'vitest';
import { Agent } from './index';

/**
 * Regression tests for #23969: a caller-provided `abortSignal` firing during
 * `generate()` / `stream()` used to resolve with a synthesized processor
 * tripwire (`finishReason: 'tripwire'`, `tripwire.reason: 'Processor tripwire
 * triggered'`, `processorId: undefined`) even with no processors configured.
 *
 * Both abort exits in llm-execution-step bail through the same helper, and that
 * helper used to hardcode `reason: 'tripwire'`; the output layer then filled in
 * a generic processor reason because no tripwire chunk ever carried one. A
 * caller cancellation was therefore indistinguishable from a processor block
 * for anyone branching on `result.tripwire`.
 */

/** A model that aborts the caller's controller mid-stream, as a timeout/cancel does. */
function createAbortingModel(abortController: AbortController) {
  let pullCalls = 0;

  return new MockLanguageModelV2({
    doStream: async () => ({
      rawCall: { rawPrompt: null, rawSettings: {} },
      warnings: [],
      stream: new ReadableStream({
        pull(controller) {
          switch (pullCalls++) {
            case 0:
              controller.enqueue({ type: 'stream-start', warnings: [] });
              break;
            case 1:
              controller.enqueue({ type: 'text-start', id: '1' });
              break;
            default:
              abortController.abort(new DOMException('Caller cancelled', 'AbortError'));
              controller.error(new DOMException('Caller cancelled', 'AbortError'));
              break;
          }
        },
      }),
    }),
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

  it('leaves tripwire unset when stream() is cancelled by the caller abortSignal', async () => {
    const abortController = new AbortController();
    const agent = new Agent({
      id: 'test-abort-tripwire-stream',
      name: 'Test Abort Tripwire Stream',
      instructions: 'You are a helpful assistant.',
      model: createAbortingModel(abortController),
    });

    const stream = await agent.stream('Hello', { abortSignal: abortController.signal });
    await stream.consumeStream();

    expect(await stream.tripwire).toBeUndefined();
    expect(await stream.finishReason).not.toBe('tripwire');
  });

  it('(control) still reports a real processor tripwire with the processor reason and id', async () => {
    const agent = new Agent({
      id: 'test-abort-tripwire-control',
      name: 'Test Abort Tripwire Control',
      instructions: 'You are a helpful assistant.',
      model: new MockLanguageModelV2({
        doStream: async () => ({
          rawCall: { rawPrompt: null, rawSettings: {} },
          warnings: [],
          stream: convertArrayToReadableStream([
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: '1' },
            { type: 'text-delta', id: '1', delta: 'blocked content' },
            { type: 'text-end', id: '1' },
            {
              type: 'finish',
              finishReason: 'stop',
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            },
          ]),
        }),
      }),
      outputProcessors: [
        {
          name: 'blocker',
          processOutputResult: async ({ abort }: any) => {
            abort('Blocked by policy');
            return [];
          },
        } as any,
      ],
    });

    const result = await agent.generate('Hello');

    expect(result.tripwire).toBeDefined();
    expect(result.tripwire?.reason).toBe('Blocked by policy');
    expect(result.tripwire?.processorId).toBe('blocker');
  });
});
