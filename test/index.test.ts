import { describe, it, expect, vi } from "vitest";
import { CircuitBreaker, CircuitBreakerOpenError } from "../src/index.js";

class FakeClock {
  private t = 0;
  now = () => this.t;
  advance(ms: number) { this.t += ms; }
}

describe("closed: pass through", () => {
  it("returns successful results", async () => {
    const cb = new CircuitBreaker({ now: new FakeClock().now });
    expect(await cb.execute(async () => 1)).toBe(1);
  });

  it("counts consecutive failures and trips after threshold", async () => {
    const clock = new FakeClock();
    const cb = new CircuitBreaker({ failureThreshold: 3, now: clock.now });
    for (let i = 0; i < 3; i++) {
      await expect(cb.execute(async () => { throw new Error("x"); })).rejects.toThrow("x");
    }
    expect(cb.state).toBe("open");
    await expect(cb.execute(async () => 1)).rejects.toBeInstanceOf(CircuitBreakerOpenError);
  });

  it("resets failure count on success", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 3 });
    await expect(cb.execute(async () => { throw new Error("x"); })).rejects.toThrow();
    await expect(cb.execute(async () => { throw new Error("x"); })).rejects.toThrow();
    await cb.execute(async () => 1);
    expect(cb.stats.failures).toBe(0);
  });
});

describe("open → half-open transition", () => {
  it("transitions to half-open after resetTimeout", async () => {
    const clock = new FakeClock();
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1000, now: clock.now });
    await expect(cb.execute(async () => { throw new Error("x"); })).rejects.toThrow();
    expect(cb.state).toBe("open");
    clock.advance(1001);
    expect(cb.state).toBe("half-open");
  });
});

describe("half-open behavior", () => {
  it("closes after successThreshold probes succeed", async () => {
    const clock = new FakeClock();
    const cb = new CircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 100,
      successThreshold: 2,
      now: clock.now,
    });
    await expect(cb.execute(async () => { throw new Error("x"); })).rejects.toThrow();
    clock.advance(101);

    await cb.execute(async () => 1);
    expect(cb.state).toBe("half-open");
    await cb.execute(async () => 1);
    expect(cb.state).toBe("closed");
  });

  it("re-opens on first probe failure", async () => {
    const clock = new FakeClock();
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 100, now: clock.now });
    await expect(cb.execute(async () => { throw new Error("x"); })).rejects.toThrow();
    clock.advance(101);
    await expect(cb.execute(async () => { throw new Error("y"); })).rejects.toThrow("y");
    expect(cb.state).toBe("open");
  });
});

describe("isFailure filter", () => {
  it("ignores errors filtered out", async () => {
    const cb = new CircuitBreaker({
      failureThreshold: 2,
      isFailure: (e) => !(e instanceof TypeError),
    });
    for (let i = 0; i < 5; i++) {
      await expect(cb.execute(async () => { throw new TypeError("user"); })).rejects.toThrow();
    }
    expect(cb.state).toBe("closed");
  });
});

describe("onStateChange", () => {
  it("invoked on transitions", async () => {
    const transitions: string[] = [];
    const clock = new FakeClock();
    const cb = new CircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 100,
      now: clock.now,
      onStateChange: (from, to) => transitions.push(`${from}->${to}`),
    });
    await expect(cb.execute(async () => { throw new Error("x"); })).rejects.toThrow();
    clock.advance(101);
    await cb.execute(async () => 1);
    expect(transitions).toEqual(["closed->open", "open->half-open", "half-open->closed"]);
  });
});

describe("reset / trip", () => {
  it("reset() forces closed", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1 });
    await expect(cb.execute(async () => { throw new Error("x"); })).rejects.toThrow();
    expect(cb.state).toBe("open");
    cb.reset();
    expect(cb.state).toBe("closed");
  });
  it("trip() forces open", async () => {
    const cb = new CircuitBreaker();
    cb.trip();
    expect(cb.state).toBe("open");
    await expect(cb.execute(async () => 1)).rejects.toBeInstanceOf(CircuitBreakerOpenError);
  });
});
