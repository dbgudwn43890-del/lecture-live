/** Numeric request phases only: never includes identities, SQL or provider data. */
export function requestTiming() {
  const started = performance.now();
  const phases: Array<{ name: string; duration: number }> = [];
  return {
    async measure<T>(name: "auth" | "limit" | "read" | "write", operation: () => PromiseLike<T>): Promise<T> {
      const start = performance.now();
      try { return await operation(); }
      finally { phases.push({ name, duration: performance.now() - start }); }
    },
    headers() {
      return {
        "Cache-Control": "private, no-store",
        "Server-Timing": [...phases, { name: "total", duration: performance.now() - started }]
          .map(({ name, duration }) => `${name};dur=${Math.max(0, duration).toFixed(1)}`).join(", "),
      };
    },
  };
}
