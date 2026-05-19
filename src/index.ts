export type CircuitState = "closed" | "open" | "half-open";

export class CircuitBreakerOpenError extends Error {
  override readonly name = "CircuitBreakerOpenError";
  constructor(message = "circuit is open") {
    super(message);
  }
}

export interface CircuitBreakerOptions {
  /** Consecutive failures required to open the circuit. Default 5. */
  failureThreshold?: number;
  /** Milliseconds the circuit stays open before allowing a probe. Default 30_000. */
  resetTimeoutMs?: number;
  /** Consecutive successes in half-open required to close the circuit. Default 1. */
  successThreshold?: number;
  /**
   * Filter for what counts as a failure. By default any thrown error is one;
   * provide this to ignore certain errors (e.g. 4xx user errors).
   */
  isFailure?: (err: unknown) => boolean;
  /** State-transition callback for metrics/logging. */
  onStateChange?: (from: CircuitState, to: CircuitState) => void;
  /** Injectable clock for tests. Default `Date.now`. */
  now?: () => number;
}

/**
 * A small circuit breaker. Wrap any async operation in `execute()`;
 * the breaker keeps a state machine and short-circuits when downstream is
 * in distress.
 *
 * States:
 *   - closed:    normal traffic; failures counted.
 *   - open:      `execute()` throws `CircuitBreakerOpenError` immediately.
 *   - half-open: a single probe is allowed; success closes, failure re-opens.
 */
export class CircuitBreaker {
  private _state: CircuitState = "closed";
  private failures = 0;
  private successes = 0;
  private openedAt = 0;
  private inFlightProbe = false;

  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly successThreshold: number;
  private readonly isFailureFn: (err: unknown) => boolean;
  private readonly onStateChange?: (from: CircuitState, to: CircuitState) => void;
  private readonly now: () => number;

  constructor(opts: CircuitBreakerOptions = {}) {
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.resetTimeoutMs = opts.resetTimeoutMs ?? 30_000;
    this.successThreshold = opts.successThreshold ?? 1;
    this.isFailureFn = opts.isFailure ?? (() => true);
    this.onStateChange = opts.onStateChange;
    this.now = opts.now ?? Date.now;
  }

  get state(): CircuitState {
    // Lazy transition: if open and reset elapsed, expose half-open even before a call.
    if (this._state === "open" && this.now() - this.openedAt >= this.resetTimeoutMs) {
      return "half-open";
    }
    return this._state;
  }

  get stats(): { state: CircuitState; failures: number; successes: number } {
    return { state: this.state, failures: this.failures, successes: this.successes };
  }

  private transition(to: CircuitState): void {
    if (this._state === to) return;
    const from = this._state;
    this._state = to;
    if (to === "open") {
      this.openedAt = this.now();
      this.successes = 0;
      this.inFlightProbe = false;
    }
    if (to === "closed") {
      this.failures = 0;
      this.successes = 0;
      this.inFlightProbe = false;
    }
    if (to === "half-open") {
      this.successes = 0;
      this.inFlightProbe = false;
    }
    this.onStateChange?.(from, to);
  }

  /**
   * Run `fn` through the breaker. Throws `CircuitBreakerOpenError` when the
   * circuit refuses the call; otherwise propagates the original error.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this._state === "open" && this.now() - this.openedAt >= this.resetTimeoutMs) {
      this.transition("half-open");
    }
    if (this._state === "open") {
      throw new CircuitBreakerOpenError();
    }
    if (this._state === "half-open") {
      if (this.inFlightProbe) {
        throw new CircuitBreakerOpenError("half-open probe already in flight");
      }
      this.inFlightProbe = true;
    }

    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (err) {
      if (this.isFailureFn(err)) this.recordFailure();
      else if (this._state === "half-open") this.inFlightProbe = false;
      throw err;
    }
  }

  private recordSuccess(): void {
    if (this._state === "half-open") {
      this.inFlightProbe = false;
      this.successes += 1;
      if (this.successes >= this.successThreshold) this.transition("closed");
    } else {
      this.failures = 0;
    }
  }

  private recordFailure(): void {
    if (this._state === "half-open") {
      this.transition("open");
      return;
    }
    this.failures += 1;
    if (this.failures >= this.failureThreshold) this.transition("open");
  }

  /** Force the circuit closed (resets failure count). */
  reset(): void {
    this.transition("closed");
  }

  /** Force the circuit open until the next reset timeout elapses. */
  trip(): void {
    this.transition("open");
  }
}
