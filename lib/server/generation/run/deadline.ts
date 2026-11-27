/**
 * The time a run gives each provider-calling step: the budget the step's 1.1.x
 * API route declared, so a hung provider fails the step the way a route
 * timeout failed the browser's request, as a retryable failure.
 */

/** Per call, in milliseconds. */
export const STEP_DEADLINES_MS = {
  /**
   * One material's extraction, once a worker runs it (1.1.x declared no
   * budget; the platform's default applied).
   */
  materialAnalysis: 300_000,
  /** Research (1.1.x declared no budget; the platform's default applied). */
  research: 300_000,
  /** The outline, its own stream retries included. */
  outline: 300_000,
  agentProfiles: 120_000,
  /**
   * Per attempt. Local patch: raised 300s -> 900s. Interactive-scene widget
   * generation through the opencode Go gateway (this deployment's chat
   * provider) takes 3-6 minutes per scene; at 300s those steps time out,
   * retry and re-timeout, so courseware stalls "generating" forever. 900s
   * matches the 15-minute LLM transport budget in lib/ai/providers.ts.
   */
  sceneContent: 900_000,
  /** Per attempt. */
  sceneActions: 60_000,
  /** Per clip attempt (POST /api/generate/tts). */
  narrationClip: 30_000,
} as const;

/** A step ran out of its budget. A gateway timeout to the retries: retried. */
export class StepTimeoutError extends Error {
  readonly statusCode = 504;

  constructor(label: string, ms: number) {
    super(`${label} did not finish within ${ms / 1000} s`);
    this.name = 'StepTimeoutError';
  }
}

/**
 * Run `call` with a signal that aborts when the run's signal does (a lost
 * lease, a deleted course, shutdown) or when `ms` pass. A timeout rejects
 * with {@link StepTimeoutError} even if the call ignores its signal; the
 * run's own abort rejects as an abort.
 */
export async function withDeadline<T>(
  label: string,
  ms: number,
  runSignal: AbortSignal,
  call: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), ms);
  const signal = AbortSignal.any([runSignal, timeout.signal]);
  const failure = () =>
    runSignal.aborted
      ? (runSignal.reason ?? new DOMException('Aborted', 'AbortError'))
      : new StepTimeoutError(label, ms);
  try {
    return await new Promise<T>((resolve, reject) => {
      if (signal.aborted) {
        reject(failure());
        return;
      }
      signal.addEventListener('abort', () => reject(failure()), { once: true });
      call(signal).then(resolve, (error) => reject(signal.aborted ? failure() : error));
    });
  } finally {
    clearTimeout(timer);
  }
}
