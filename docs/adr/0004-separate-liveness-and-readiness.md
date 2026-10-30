# ADR-0004: Separate liveness (/health) and readiness (/ready) endpoints

- **Status:** Accepted
- **Date:** 2026-10-28
- **Deciders:** Syeda Hafsa Anis

## Context

A model worker takes time to become useful after it starts: it must load a model file into memory, and the project deliberately simulates a cold start of 20–30 seconds to study autoscaling.

During that time the worker is running but can't serve predictions. Two different systems need to know about the worker's state:

- **The container platform** (Docker, Kubernetes) decides whether to *restart* the worker.
- **The gateway** decides whether to *send requests* to the worker.

A single health endpoint can't answer both questions. If it reports "unhealthy" while loading, the platform may restart the worker in a loop and it never finishes loading. If it reports "healthy" while loading, the gateway sends requests that fail.

## Decision

Every worker exposes two endpoints:

- **`GET /health` (liveness):** returns 200 if the process is running. Used by the container platform to decide on restarts.
- **`GET /ready` (readiness):** returns 200 only when the model is loaded and the worker can serve; otherwise 503. Used by the gateway to add or remove the worker from the routing pool, and by the autoscaler to count ready capacity.

A worker that is shutting down (draining) also reports not ready, so it stops receiving new requests while it finishes in-flight ones.

## Alternatives considered

| Option | Pros | Cons |
|---|---|---|
| **One `/health` endpoint** | Simpler | Can't tell "loading" from "broken"; causes restart loops or failed requests |
| **Gateway retries until a new worker works** | No extra endpoint | Wastes requests and increases latency during every scale-up |
| **Separate `/health` and `/ready`** | Each consumer gets the right signal; matches Kubernetes liveness and readiness probes | One more endpoint to maintain |

## Consequences

**Positive:**
- No restart loops while models load.
- The gateway never routes to a worker that can't serve.
- The autoscaler can measure *ready* capacity, not just running containers, which is needed to calculate the scaling reaction SLO correctly.
- Maps directly onto Kubernetes probes for the later migration.

**Negative:**
- Slightly more code and configuration in every worker.

**Follow-ups:**
- Phase 1: make `/ready` return 503 until the model is loaded.
- Phase 2: the gateway registry uses readiness, not liveness, to choose workers.
- Phase 8: the autoscaler reports `ready_replicas` as a metric.
