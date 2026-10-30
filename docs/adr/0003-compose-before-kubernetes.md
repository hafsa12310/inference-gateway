# ADR-0003: Docker Compose first, Kubernetes later

- **Status:** Accepted
- **Date:** 2026-10-28
- **Deciders:** Syeda Hafsa Anis

## Context

The system has seven services that must run together: gateway, worker, autoscaler, Redis, Postgres, Prometheus, and Grafana. Workers must be scalable, and the autoscaler must be able to start and stop them.

Kubernetes is the industry standard for this, but it has a steep learning curve and slows down day-to-day development. Most of the project's early phases are about gateway logic, not orchestration.

## Decision

Use **Docker Compose** for local development and the early phases. The autoscaler controls workers through the Docker Engine API. Move to **Kubernetes** (k3s or kind) in a later phase, once the core features work, with the autoscaler scaling a Kubernetes Deployment through its API.

The autoscaler's scaling logic is written behind an interface (e.g. `scale(model, replicas)`), so switching from Docker to Kubernetes means replacing one implementation, not rewriting the policies.

## Alternatives considered

| Option | Pros | Cons |
|---|---|---|
| **Kubernetes from day one** | Production-realistic; built-in scaling primitives | Slow feedback loop; lots of YAML; debugging cluster issues instead of building features |
| **Docker Compose only** | Simple; fast iteration; one command to start | Less impressive for infrastructure roles; no multi-node story |
| **Compose first, Kubernetes later** | Fast early progress, realistic final version | Two sets of deployment config to maintain |

## Consequences

**Positive:**
- Fast iteration while building gateway features: `make up` starts everything in seconds.
- Easy for anyone cloning the repo to run.
- The scaling interface keeps the autoscaler independent of the platform.

**Negative:**
- The autoscaler needs access to the Docker socket, which is effectively root access on the host. Acceptable for local development and a demo server, not for production.
- Compose runs on one machine, so "horizontal scaling" shares one CPU until the Kubernetes phase. This is documented as a known limitation.
- The Kubernetes migration is extra work later.

**Follow-ups:**
- Define the `Scaler` interface in the autoscaler from the start.
- Write a new ADR when migrating to Kubernetes.
