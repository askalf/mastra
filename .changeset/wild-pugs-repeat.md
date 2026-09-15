---
'@mastra/core': patch
---

Fixed cancelling an agent run with `abortSignal` being reported as a processor tripwire. A run stopped by the caller now finishes with an `abort` reason and leaves `result.tripwire` unset, so `result.tripwire` again means only that an input or output processor blocked the response.

```ts
const controller = new AbortController();
const result = await agent.generate('Hello', { abortSignal: controller.signal });

// Before: result.tripwire was { reason: 'Processor tripwire triggered', processorId: undefined }
// even with no processors configured.
// After:  result.tripwire is undefined for a caller cancellation.
```
