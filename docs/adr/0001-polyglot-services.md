# ADR-0001: TypeScript gateway with Python model workers

- **Status:** Accepted
- **Date:** 2026-10-28
- **Deciders:** Syeda Hafsa Anis

## Context

The system has two very different kinds of work:

- **The gateway** handles many concurrent network requests, routing, caching, retries, and coordination. This is I/O-heavy work.
- **The workers** load trained models and run inference. This depends on the Python ML ecosystem (scikit-learn, XGBoost, pandas, joblib).

I'm strongest in TypeScript and NestJS, and the project is meant to showcase backend skills for backend roles.

## Decision

Build the gateway in **TypeScript with NestJS**, and the model workers, autoscaler, and training code in **Python** (FastAPI for workers). The services communicate over HTTP with JSON.

## Alternatives considered

| Option | Pros | Cons |
|---|---|---|
| **All Python** (FastAPI gateway) | One language; models could run inside the gateway | Weaker showcase of my main stack; mixes routing and inference in one process |
| **All TypeScript** (ONNX Runtime for Node) | One language | Limited ML tooling; training and experimentation would still need Python |
| **TypeScript gateway + Python workers** | Each language does what it's best at; mirrors real ML platforms | Two toolchains, two sets of linting and CI jobs; HTTP adds a network hop |

## Consequences

**Positive:**
- The gateway uses my strongest skills, and the workers get full access to the ML ecosystem.
- Keeping routing and inference in separate services is required anyway for independent scaling: workers scale up and down without touching the gateway.
- Matches how production ML platforms are built, which makes the design easy to explain in interviews.

**Negative:**
- Two languages mean two dependency managers (npm and uv), two linters, and more CI configuration.
- Each prediction crosses a network hop between gateway and worker, adding a few milliseconds of latency. This fits within the 200 ms latency SLO, and batching reduces the overhead.
- Request and response formats must be kept in sync by hand across languages.

**Follow-ups:**
- Document the worker API contract in the design doc and validate it on both sides.
- Revisit gRPC instead of HTTP/JSON if serialization overhead becomes significant in benchmarks.
