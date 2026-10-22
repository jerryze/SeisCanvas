/** Where the cursor is, in original seismic coordinates. */
export type ProbeRequest = {
  kind: "inline" | "crossline" | "time";
  position: number;
  inline?: number | null;
  crossline?: number | null;
  time?: number | null;
};

export type ProbeReading = {
  kind: "inline" | "crossline" | "time";
  position: number;
  inline: number;
  crossline: number;
  time: number;
  amplitude: number | null;
  source: string;
};

type Timer = ReturnType<typeof setTimeout>;
type ProbeOptions = {
  request: (request: ProbeRequest, signal: AbortSignal) => Promise<ProbeReading>;
  onReading: (reading: ProbeReading | null) => void;
  delay?: number;
  schedule?: (callback: () => void, delay: number) => Timer;
  cancel?: (timer: Timer) => void;
};

const key = (request: ProbeRequest) =>
  [request.kind, request.position, request.inline ?? "", request.crossline ?? "", request.time ?? ""].join("|");

/** Own the debounce, bounded sample cache and latest-selection lifetime. */
export function createProbeController({
  request,
  onReading,
  delay = 60,
  schedule = (callback, wait) => setTimeout(callback, wait),
  cancel = timer => clearTimeout(timer),
}: ProbeOptions) {
  const cache = new Map<string, ProbeReading>();
  let timer: Timer | null = null;
  let pending: AbortController | null = null;
  let sequence = 0;
  let disposed = false;

  function invalidate() {
    sequence++;
    if (timer !== null) {
      cancel(timer);
      timer = null;
    }
    pending?.abort();
    pending = null;
    return sequence;
  }

  return {
    probe(value: ProbeRequest) {
      if (disposed) return;
      // Cached selections also supersede scheduled and in-flight requests.
      const token = invalidate();
      const id = key(value);
      const hit = cache.get(id);
      if (hit) {
        onReading(hit);
        return;
      }
      timer = schedule(() => {
        timer = null;
        if (disposed || token !== sequence) return;
        const abort = new AbortController();
        pending = abort;
        void (async () => {
          try {
            const reading = await request(value, abort.signal);
            // Some transports can finish parsing after cancellation.
            if (disposed || token !== sequence || abort.signal.aborted) return;
            if (cache.size > 4096) cache.clear();
            cache.set(id, reading);
            onReading(reading);
          } catch {
            /* A missing probe must never interrupt browsing. */
          } finally {
            if (pending === abort) pending = null;
          }
        })();
      }, delay);
    },
    reset() {
      if (disposed) return;
      invalidate();
      onReading(null);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      invalidate();
      cache.clear();
    },
  };
}
