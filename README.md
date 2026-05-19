# circuit-breaker

[![ci](https://github.com/p-vbordei/circuit-breaker/actions/workflows/ci.yml/badge.svg)](https://github.com/p-vbordei/circuit-breaker/actions/workflows/ci.yml)

[![npm](https://img.shields.io/npm/v/%40p-vbordei%2Fcircuit-breaker.svg)](https://www.npmjs.com/package/@p-vbordei/circuit-breaker)
[![downloads](https://img.shields.io/npm/dm/%40p-vbordei%2Fcircuit-breaker.svg)](https://www.npmjs.com/package/@p-vbordei/circuit-breaker)
[![bundle](https://img.shields.io/bundlejs/size/%40p-vbordei%2Fcircuit-breaker)](https://bundlejs.com/?q=%40p-vbordei%2Fcircuit-breaker)

A tiny circuit breaker for async operations. Wrap any function in `execute()`; the breaker short-circuits when the downstream is failing, then probes for recovery automatically.

```ts
import { CircuitBreaker, CircuitBreakerOpenError } from "@p-vbordei/circuit-breaker";

const cb = new CircuitBreaker({
  failureThreshold: 5,      // open after 5 consecutive failures
  resetTimeoutMs: 30_000,   // wait 30s before probing again
  successThreshold: 1,      // 1 successful probe → close
  isFailure: (err) => !(err instanceof InputError),
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

## API

### `new CircuitBreaker(opts?)`

| Option | Type | Default | Meaning |
|---|---|---|---|
| `failureThreshold` | `number` | `5` | Consecutive failures to open |
| `resetTimeoutMs` | `number` | `30000` | Wait before allowing a probe |
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

### Errors

`CircuitBreakerOpenError` is the only error the breaker itself throws. Everything else is propagated unchanged from the wrapped function.

## License

Apache-2.0 © Vlad Bordei
