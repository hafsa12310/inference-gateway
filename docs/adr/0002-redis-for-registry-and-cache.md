# ADR-0002: Redis for the worker registry, prediction cache, and rate limiting

- **Status:** Accepted
- **Date:** 2026-10-28
- **Deciders:** Syeda Hafsa Anis

## Context

Three features need fast state that is shared across services and across multiple gateway instances:

1. **Worker registry:** workers announce themselves and must disappear automatically if they die.
2. **Prediction cache:** results stored with an expiry time.
3. **Rate limiting:** token buckets that must update atomically, even with several gateway instances.

None of this state is critical to keep forever. Losing it means slower responses for a while, not lost data.

## Decision

Use **Redis** for all three:
- The registry uses keys with a TTL refreshed by heartbeats (`SET worker:{id} ... EX 15`).
- The cache uses keys with a TTL, with the model version in the key.
- Rate limiting uses a token bucket implemented as a Lua script, so each check-and-update is atomic.

Durable data (model registry, routing rules, logs, experiment results) goes in Postgres instead.

## Alternatives considered

| Option | Pros | Cons |
|---|---|---|
| **etcd or Consul** for the registry | Built for service discovery; strong consistency; watch APIs | Another system to run; no use for caching; heavier than needed |
| **Memcached** for the cache | Simple and fast | No TTL-based registry patterns, no Lua scripting, no pub/sub |
| **In-memory state in the gateway** | No extra dependency | Breaks with more than one gateway instance; lost on restart |
| **Redis for all three** | One tool; TTLs, atomic scripts, and pub/sub built in; widely used | Single point of failure unless replicated; weaker consistency than etcd |

## Consequences

**Positive:**
- One extra service covers three features, which keeps the system simpler to run and explain.
- TTL keys give automatic cleanup of dead workers with no extra code.
- Lua scripts make distributed rate limiting correct across multiple gateways.

**Negative:**
- Redis becomes a single point of failure for caching, rate limiting, and discovery. The gateway must degrade gracefully when Redis is down (see the failure scenarios in the design doc).
- Redis doesn't provide the strong consistency of etcd. A worker may briefly remain in the registry after dying (up to the 15-second TTL); passive health checks and circuit breakers cover that gap.

**Follow-ups:**
- Keep a local copy of the last-known worker list in the gateway for when Redis is unavailable.
- Decide how rate limiting behaves without Redis (open question in the design doc).
