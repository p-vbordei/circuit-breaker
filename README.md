# circuit-breaker

[![ci](https://github.com/p-vbordei/circuit-breaker/actions/workflows/ci.yml/badge.svg)](https://github.com/p-vbordei/circuit-breaker/actions/workflows/ci.yml)

[![npm](https://img.shields.io/npm/v/%40p-vbordei%2Fcircuit-breaker.svg)](https://www.npmjs.com/package/@p-vbordei/circuit-breaker)
[![downloads](https://img.shields.io/npm/dm/%40p-vbordei%2Fcircuit-breaker.svg)](https://www.npmjs.com/package/@p-vbordei/circuit-breaker)
[![bundle](https://img.shields.io/bundlejs/size/%40p-vbordei%2Fcircuit-breaker)](https://bundlejs.com/?q=%40p-vbordei%2Fcircuit-breaker)

> A tiny circuit breaker for async operations. Wrap any function in `execute()`; the breaker short-circuits when the downstream is failing, then probes for recovery automatically.

```ts
import { CircuitBreaker, CircuitBreakerOpenError } from "@p-vbordei/circuit-breaker";

const cb = new CircuitBreaker({
  failureThreshold: 5,      // open after 5 consecutive failures
  resetTimeoutMs: 30_000,   // wait 30s before probing again
  successThreshold: 1,      // 1 successful probe → close
  onStateChange: (from, to) => metrics.gauge("breaker.state", to),
});

try {
  const data = await cb.execute(() => fetch(url).then(r => r.json()));
} catch (err) {
  if (err instanceof CircuitBreakerOpenError) {
    // serve stale cache, fall back, etc.
  }
  throw err;
}
```

## Install

```sh
npm install @p-vbordei/circuit-breaker
```

Works with Node 20+, browsers, Bun, Deno. ESM + CJS.

## Why

A circuit breaker prevents a misbehaving downstream from cascading into your service. When the downstream starts failing repeatedly:

- **Without a breaker**: every request keeps hammering the failing service, your worker pool fills up with hanging calls, latency spikes, eventually you fall over.
- **With a breaker**: after N consecutive failures, the breaker "trips open" and all subsequent calls fail fast (no network call made). Periodically it lets one probe through to test recovery.

Most existing libraries (`opossum`) are ~150KB with metric integrations, configurable strategies, event emitters. This is ~150 lines: just the state machine, with hooks if you want metrics.

## States

```
       failures ≥ threshold              probe succeeds
closed ─────────────────────► open ────────────────────► closed
   ▲                            │                          │
   │                            │ reset timeout elapses    │
   │                            ▼                          │
   └─────── probe fails ─── half-open ─── probe succeeds ──┘
```

In `half-open`, only **one** probe is allowed in flight at a time. Other callers receive `CircuitBreakerOpenError` until the probe resolves.

## Recipes

### Fallback to cache when breaker is open

```ts
import { CircuitBreaker, CircuitBreakerOpenError } from "@p-vbordei/circuit-breaker";

const cb = new CircuitBreaker({ failureThreshold: 5, resetTimeoutMs: 30_000 });

async function getUser(id: string): Promise<User> {
  try {
    const user = await cb.execute(() => api.getUser(id));
    cache.set(id, user);
    return user;
  } catch (err) {
    if (err instanceof CircuitBreakerOpenError) {
      const cached = cache.get(id);
      if (cached) return cached;
    }
    throw err;
  }
}
```

### Per-host breaker map

```ts
import { CircuitBreaker } from "@p-vbordei/circuit-breaker";

const breakers = new Map<string, CircuitBreaker>();

function breakerFor(host: string) {
  let b = breakers.get(host);
  if (!b) {
    b = new CircuitBreaker({
      failureThreshold: 5,
      resetTimeoutMs: 30_000,
      onStateChange: (from, to) => metrics.gauge(`breaker.${host}.state`, to),
    });
    breakers.set(host, b);
  }
  return b;
}

await breakerFor(new URL(url).host).execute(() => fetch(url));
```

### Ignore 4xx, trip only on 5xx

```ts
import { CircuitBreaker } from "@p-vbordei/circuit-breaker";

const cb = new CircuitBreaker({
  failureThreshold: 5,
  isFailure: (err) => {
    if (err && typeof err === "object" && "status" in err) {
      return (err as { status: number }).status >= 500;
    }
    return true;
  },
});
```

### Combine with pretry — retry inside, breaker outside

```ts
import { retry, isRetriableHttpError } from "@p-vbordei/pretry";
import { CircuitBreaker } from "@p-vbordei/circuit-breaker";

const cb = new CircuitBreaker({ failureThreshold: 5 });

const data = await cb.execute(() =>
  retry(
    async () => {
      const r = await fetch(url);
      if (!r.ok) throw r;
      return r.json();
    },
    { retries: 3, retryOn: isRetriableHttpError },
  ),
);
```

If retries are exhausted, the resulting error counts as ONE breaker failure (not 4).

## API

### `new CircuitBreaker(opts?)`

| Option | Type | Default | Meaning |
|---|---|---|---|
| `failureThreshold` | `number` | `5` | Consecutive failures to open |
| `resetTimeoutMs` | `number` | `30_000` | Wait before allowing a probe |
| `successThreshold` | `number` | `1` | Consecutive successes in half-open to close |
| `isFailure` | `(err) => boolean` | always true | Filter — return false to ignore an error |
| `onStateChange` | `(from, to) => void` | — | State-transition hook |
| `now` | `() => number` | `Date.now` | Injectable clock |

### Methods

- `execute<T>(fn): Promise<T>` — run `fn` through the breaker
- `state` — current state (lazy: shows `half-open` once reset timeout has elapsed)
- `stats` — `{ state, failures, successes }`
- `reset()` — force closed
- `trip()` — force open

`CircuitBreakerOpenError` is the only error the breaker itself throws. Everything else is propagated unchanged from the wrapped function.

## Caveats

- **Per-instance, not distributed.** Each Node process / browser tab has its own breaker. If you have 10 workers all hammering a failing API, each tracks its own failure count. For shared state, you need a coordinator (Redis-backed breaker libraries exist but ship with a lot more).
- **No half-open queue.** Calls during half-open while a probe is in flight fail with `CircuitBreakerOpenError`. If you want to queue them, wrap with [@p-vbordei/pqueue-tiny](https://github.com/p-vbordei/pqueue-tiny).
- **No metrics built in.** Use the `onStateChange` hook + your existing metrics client.

## License

Apache-2.0 © Vlad Bordei
