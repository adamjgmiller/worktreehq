// Yield to the browser's event loop so pending scroll/input/paint work can
// run before we continue. Used between sync-heavy phases in the refresh
// pipeline so a long JS pass (parse, detect, enrich) doesn't monopolize the
// main thread and drop frames during scroll.
//
// Fallback chain:
//   1. scheduler.yield()          — explicit cooperative yield (Chromium 129+)
//   2. MessageChannel postMessage — true ~0ms yield, bypasses setTimeout clamps
//   3. setTimeout(0)              — universal fallback (~4ms clamp)
//
// Tauri's macOS webview is WKWebView, which does not ship scheduler.yield as
// of this writing, so the MessageChannel path is what's exercised in prod.
// setTimeout is only reached in environments with neither (test runner).

interface SchedulerWithYield {
  yield?: () => Promise<void>;
}

declare global {
  interface Window {
    scheduler?: SchedulerWithYield;
  }
}

// FIFO of pending resolvers. We share a single MessageChannel across calls
// to avoid repeated allocation, and dispatch one resolver per port1 message
// so concurrent yieldToMain() callers don't clobber each other.
const pendingResolvers: Array<() => void> = [];
let messageChannel: MessageChannel | null = null;

function getMessageChannel(): MessageChannel {
  if (messageChannel) return messageChannel;
  messageChannel = new MessageChannel();
  messageChannel.port1.onmessage = () => {
    const resolve = pendingResolvers.shift();
    resolve?.();
  };
  return messageChannel;
}

export function yieldToMain(): Promise<void> {
  // scheduler.yield() is the web standard successor to isInputPending. Not
  // in WKWebView yet, but we probe it cheaply so we benefit automatically if
  // it lands.
  if (
    typeof window !== 'undefined' &&
    window.scheduler &&
    typeof window.scheduler.yield === 'function'
  ) {
    return window.scheduler.yield();
  }
  // MessageChannel is the canonical low-latency yield in browsers — Jake
  // Archibald's "tasks, microtasks, queues, schedules" post is the reference.
  // It posts a message to port2 and resolves when port1 receives it, which
  // happens in a fresh task without setTimeout's minimum clamp.
  if (typeof MessageChannel !== 'undefined') {
    return new Promise<void>((resolve) => {
      pendingResolvers.push(resolve);
      getMessageChannel().port2.postMessage(null);
    });
  }
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}
