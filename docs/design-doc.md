# Design Doc: Self-Scaling ML Inference Gateway

| | |
|---|---|
| **Author** | Syeda Hafsa Anis |
| **Status** | Draft |
| **Created** | 2026-10-28 |
| **Last updated** | 2026-10-28 |
| **Related** | [SLOs](./slos.md), [ADRs](./adr/) |

## 1. Summary

This project is a gateway that serves machine learning models over an HTTP API. It routes prediction requests to a pool of model workers, protects itself against failures, caches results, supports safe rollout of new model versions, and scales the number of workers automatically.

Its distinguishing feature is **predictive autoscaling**: a regression model forecasts incoming traffic a few minutes ahead, so the system adds workers *before* load arrives rather than after. The project includes an experiment comparing predictive, reactive, and hybrid scaling policies against defined SLOs.

## 2. Background and problem

Serving ML models in production is harder than training them. A serving system has to deal with:

- **Variable load.** Traffic rises and falls during the day and can spike suddenly.
- **Cold starts.** A new worker needs time to start and load its model (tens of seconds), so capacity can't appear instantly.
- **Model updates.** New model versions must be released without breaking users, and rolled back quickly if they perform worse.
- **Partial failures.** Individual workers crash, slow down, or return errors, and the system must keep serving.

Reactive autoscaling, which adds capacity once load is already high, is the common approach (e.g. the Kubernetes Horizontal Pod Autoscaler). Because of cold starts, reactive scaling always lags behind a spike, and users experience slow or failed requests during that gap. Predictive scaling tries to close the gap by acting on a forecast.

Production systems that address these problems include KServe, Seldon, BentoML, Ray Serve, AWS SageMaker, and AWS EC2 Predictive Scaling. This project is a from-scratch, simplified system modeled on them, built to understand their internals and to measure when predictive scaling helps.

## 3. Goals

1. **Serve predictions** from at least two models (one regression, one classification) through a single gateway API.
2. **Route traffic reliably** across multiple workers with pluggable load-balancing strategies, health checking, timeouts, retries, and circuit breaking.
3. **Improve performance** with a prediction cache and request micro-batching.
4. **Release models safely** with versioning, A/B testing, shadow traffic, and automated canary rollout and rollback.
5. **Scale automatically** using reactive, predictive, and hybrid policies.
6. **Measure everything** with metrics and dashboards, and answer the research question: *under which traffic patterns does predictive autoscaling beat reactive autoscaling?*

## 4. Non-goals

These are deliberately out of scope, to keep the project focused:

- GPU inference or large models (LLMs, deep vision models).
- Multi-region or multi-cluster deployment.
- Full authentication and authorization. Simple API keys are enough.
- Model training pipelines and feature stores. Models are trained offline and loaded as files.
- Exactly-once request semantics. Predictions are idempotent, so at-least-once is acceptable.
- Production-grade security hardening beyond basic practices.

## 5. Architecture

```
                     ┌──────────────────┐
   Clients ───────▶  │   API Gateway    │  NestJS
   (k6 load gen)     │  rate limiter    │
                     │  cache lookup    │◀──────▶  Redis
                     │  A/B / canary    │          (cache, registry, rate limits)
                     │  load balancer   │
                     │  batcher         │
                     │  circuit breaker │──────▶  Postgres
                     └───────┬──────────┘          (models, routing rules, logs)
                             │
          ┌──────────────────┼──────────────────┐
          ▼                  ▼                  ▼
   ┌────────────┐     ┌────────────┐     ┌────────────┐
   │ Worker v1  │     │ Worker v1  │     │ Worker v2  │   FastAPI + Python models
   └────────────┘     └────────────┘     └────────────┘
          └──────── heartbeats + /metrics ──────┘
                             │
                     ┌───────▼────────┐
                     │  Prometheus    │──▶ Grafana
                     └───────┬────────┘
                             │ RPS time series
                     ┌───────▼────────┐
                     │  Autoscaler    │──▶ Docker API / Kubernetes API
                     └────────────────┘
```

### Components

| Component | Technology | Responsibility |
|---|---|---|
| **Gateway** | NestJS (TypeScript) | Public entry point. Validates requests, applies rate limits, checks the cache, picks a model version, picks a worker, batches requests, and handles failures. |
| **Model worker** | FastAPI (Python), scikit-learn / XGBoost | Loads one model version and returns predictions. Stateless, so any number of identical workers can run. |
| **Autoscaler** | Python | Control loop that reads metrics, forecasts traffic, decides the desired number of workers, and starts or stops containers. |
| **Redis** | Redis 7 | Fast shared state: prediction cache, worker registry (heartbeats), rate-limit buckets. |
| **Postgres** | PostgreSQL 16 | Durable state: model registry, routing rules, prediction logs, experiment results. |
| **Prometheus** | Prometheus | Scrapes and stores metrics from all services. Source of data for the autoscaler and the experiment. |
| **Grafana** | Grafana | Dashboards for traffic, latency, scaling, and canary analysis. |
| **Load generator** | k6 | Produces realistic traffic patterns for testing and experiments. |

### Key design principles

- **Stateless workers.** All shared state lives in Redis or Postgres, so workers can be added or removed freely.
- **The gateway is the only public service.** Workers, Redis, Postgres, and Prometheus sit on a private network.
- **Fail fast.** Services validate their configuration at startup, every network call has a timeout, and overloaded components reject work early rather than queueing it indefinitely.
- **Graceful degradation.** Losing a non-critical dependency (cache, autoscaler) reduces quality but doesn't stop serving.

## 6. API contracts

### 6.1 Public gateway API

**`POST /v1/models/{name}/predict`**

Headers:
- `X-API-Key` (required)
- `X-User-Id` (optional; used for sticky A/B assignment)
- `X-Request-Id` (optional; generated if missing)

Request:
```json
{
  "features": {
    "tenure_months": 14,
    "monthly_charges": 72.5,
    "contract_type": "month-to-month"
  }
}
```

Response `200`:
```json
{
  "model": "churn",
  "version": "v2",
  "prediction": { "label": 1, "probability": 0.81 },
  "cached": false,
  "latency_ms": 23,
  "request_id": "b7c1e0f2-..."
}
```

For the regression model, `prediction` is `{ "value": 34.2 }`.

**Error format** (all errors):
```json
{
  "error": {
    "code": "MODEL_UNAVAILABLE",
    "message": "No healthy workers for model 'churn'",
    "request_id": "b7c1e0f2-..."
  }
}
```

| Status | Code | Meaning |
|---|---|---|
| 400 | `INVALID_INPUT` | Missing or invalid features |
| 401 | `UNAUTHORIZED` | Missing or invalid API key |
| 404 | `MODEL_NOT_FOUND` | Unknown model name |
| 429 | `RATE_LIMITED` | Client exceeded its rate limit; includes `Retry-After` |
| 503 | `MODEL_UNAVAILABLE` / `OVERLOADED` | No healthy workers, or load shedding; includes `Retry-After` |
| 504 | `UPSTREAM_TIMEOUT` | Worker didn't respond in time |

**Other gateway endpoints**

| Endpoint | Purpose |
|---|---|
| `GET /v1/models` | List models, versions, and current traffic split |
| `PUT /v1/admin/routing/{name}` | Update a model's routing rule (admin key required) |
| `GET /health` | Liveness |
| `GET /metrics` | Prometheus metrics |

### 6.2 Internal worker API

| Endpoint | Purpose |
|---|---|
| `POST /predict` | Single prediction: `{ "features": {...} }` → `{ "prediction": {...} }` |
| `POST /predict/batch` | Batch prediction: `{ "items": [{...}, ...] }` → `{ "predictions": [...] }`, same order as input |
| `GET /health` | Liveness: the process is running |
| `GET /ready` | Readiness: the model is loaded and the worker can serve. Returns 503 until then |
| `GET /metrics` | Prometheus metrics |

### 6.3 Worker registry (Redis)

Each worker sends a heartbeat every 5 seconds:

```
SET worker:{worker_id} '{"id":"...","host":"...","port":8000,"model":"churn","version":"v1","started_at":"..."}' EX 15
```

A worker that misses three heartbeats expires automatically and leaves the routing pool.

## 7. Request flow

What happens when a client calls `POST /v1/models/churn/predict`:

1. **Validate.** Check the API key and request schema. Reject with 400 or 401 if invalid.
2. **Rate limit.** Take a token from the client's bucket in Redis. If empty, return 429.
3. **Choose a version.** Apply the model's routing rule (e.g. 90% v1, 10% v2). If `X-User-Id` is present, hash it so the same user always gets the same version. If shadow mode is on, also send a copy to the shadow version in the background.
4. **Check the cache.** Build the key `pred:{model}:{version}:{sha256(normalized_features)}`. On a hit, return immediately with `"cached": true`. If an identical request is already in flight, wait for its result instead of sending a duplicate (request coalescing).
5. **Batch.** Add the request to the model version's batch buffer. The buffer flushes at 32 items or 10 ms, whichever comes first.
6. **Choose a worker.** The load balancer picks a ready worker whose circuit breaker is not open, using the configured strategy (round-robin, least-connections, or consistent hashing).
7. **Call the worker** with a timeout. On failure, retry once on a different worker with backoff and jitter, and record the failure in that worker's circuit breaker.
8. **Respond and record.** Store the result in the cache with a TTL, log the prediction, update metrics, and return the response.

## 8. Autoscaling design

The autoscaler runs a control loop every 15–30 seconds:

1. Read current RPS per model and the number of ready workers from Prometheus.
2. Compute the desired number of workers using the active policy.
3. Apply guardrails.
4. Start or stop worker containers to match.

### Policies

`C` is the benchmarked capacity of one worker: the highest RPS it sustains while meeting the latency SLO. It is measured in Phase 1.

| Policy | Formula |
|---|---|
| **Reactive** | `desired = ceil(current_rps / (C × target_utilization))`, with target utilization around 0.7 |
| **Predictive** | `desired = ceil(forecast_p90(t + h) / C × (1 + headroom))`, with horizon `h` ≈ 5 min and headroom ≈ 20% |
| **Hybrid** | `desired = max(reactive, predictive)` |

The predictive policy scales on the **90th-percentile forecast**, not the average. Under-predicting causes SLO violations while over-predicting only costs extra workers, so the forecast deliberately leans high.

The forecast horizon must be longer than worker cold-start time plus scaling delay. Otherwise the forecast arrives too late to help.

### Guardrails

- Minimum and maximum replica counts per model.
- Scale up quickly, scale down slowly: wait for a cooldown (e.g. 5 minutes of low load) before removing workers. This prevents flapping.
- Limit each step to, for example, 50% more replicas per cycle.
- **Graceful scale-down:** mark a worker as draining, stop routing new requests to it, let in-flight requests finish, then stop it.

### Forecasting model

- **Data:** RPS per minute from Prometheus.
- **Features:** lagged RPS (1, 5, 15, 60 minutes, and the same minute yesterday), rolling mean and standard deviation, hour of day as sine and cosine, day of week, recent trend.
- **Models compared:** naive last value (baseline), linear regression, ridge regression, gradient boosting, and quantile regression at the 90th percentile.
- **Validation:** walk-forward (train on the past, test on the next window), never random splits.
- **Retraining:** periodically on a sliding window.

## 9. Data model (Postgres)

| Table | Key columns | Purpose |
|---|---|---|
| `models` | `name`, `version`, `artifact_path`, `status` (`active`, `canary`, `shadow`, `retired`), `created_at` | Model registry |
| `routing_rules` | `model_name`, `splits` (JSON), `shadow_version`, `updated_at` | How traffic is divided between versions |
| `prediction_logs` | `request_id`, `model`, `version`, `features` (JSON), `prediction` (JSON), `latency_ms`, `cached`, `created_at` | Offline comparison of versions |
| `canary_runs` | `id`, `model`, `baseline_version`, `canary_version`, `stage`, `result`, `started_at`, `ended_at` | History of canary rollouts |
| `experiment_runs` | `id`, `policy`, `traffic_pattern`, `cold_start_s`, `metrics` (JSON), `started_at` | Results of the scaling experiment |

## 10. Failure scenarios

| Failure | How it's detected | How the system responds |
|---|---|---|
| Worker crashes | Missed heartbeats; failed requests | Removed from the routing pool when its registry key expires; in-flight requests retry on another worker; autoscaler replaces it |
| Worker becomes slow | Timeouts and rising latency | Circuit breaker opens and traffic skips it; half-open probes test recovery |
| Worker is starting up | `/ready` returns 503 | Not added to the routing pool until ready |
| All workers for a model are down | No ready workers in the registry | Return a cached prediction if one exists; otherwise 503 with `Retry-After` |
| Redis is down | Connection errors | Gateway serves without cache and rate limiting, keeping a local copy of the last-known worker list; alert raised |
| Postgres is down | Connection errors | Gateway serves using its in-memory copy of routing rules; prediction logging is skipped |
| Autoscaler crashes | Missing autoscaler metrics | Existing workers keep serving at the current scale; nothing scales until it restarts |
| Traffic exceeds maximum capacity | Queue depth and latency rise | Load shedding returns 503 early; rate limits protect against single heavy clients |
| Bad model version deployed | Canary error rate, latency, or prediction drift worse than baseline | Automatic rollback to the previous version |
| Gateway crashes | Container healthcheck fails | Docker or Kubernetes restarts it; running more than one gateway instance avoids downtime |

## 11. Observability

**Metrics**

| Source | Metrics |
|---|---|
| Gateway | Requests per second by model, version, and status; latency histogram; cache hit ratio; in-flight requests; batch sizes; circuit breaker state per worker; rate-limit rejections; shed requests |
| Worker | Inference time; batch sizes; model load time; CPU and memory |
| Autoscaler | Actual RPS; forecast RPS; current, desired, and ready replicas; scaling events |

**Logs:** structured JSON with `request_id` passed through every service, so one request can be followed end to end.

**Dashboards:** traffic overview, latency vs. SLO, scaling activity (forecast vs. actual vs. replicas), canary comparison.

**Tracing (optional):** OpenTelemetry with Jaeger.

## 12. Security

- Only the gateway is exposed publicly; all other services are on a private network.
- API keys for prediction requests; a separate admin key for routing changes.
- Rate limiting per API key.
- Secrets come from environment variables and are never committed; a pre-commit secret scanner enforces this.
- Containers run as non-root users.
- Input validation on every request.

## 13. Testing and evaluation

- **Unit tests:** load-balancing strategies, circuit breaker state changes, cache key normalization, scaling policy formulas.
- **Integration tests:** the full stack started with Docker Compose in CI, with a smoke test against `/health`.
- **Load tests:** k6 scripts for each traffic pattern.
- **Chaos tests:** killing workers, injecting latency with Toxiproxy, stopping Redis and the autoscaler.
- **Main experiment:** reactive, predictive, hybrid, and fixed over-provisioned policies, each run against four traffic patterns (daily cycle, gradual ramp, recurring spike, random flash crowd), at least three runs each, measured against the [SLOs](./slos.md). A second experiment varies cold-start time (5 s, 30 s, 60 s).

## 14. Milestones

| Phase | Deliverable |
|---|---|
| 0 | Repository, skeleton services, Docker Compose, CI, this design doc, SLOs, ADRs |
| 1 | Trained models, real worker inference, cold-start simulation, per-worker capacity benchmark |
| 2 | Gateway proxy, worker registry, health checks, load-balancing strategies |
| 3 | Timeouts, retries, circuit breakers, rate limiting, load shedding |
| 4 | Prediction cache, request coalescing, micro-batching |
| 5 | Model registry, A/B testing, shadow traffic, automated canary |
| 6 | Metrics, dashboards, structured logs |
| 7 | Traffic forecasting model |
| 8 | Autoscaler with all three policies |
| 9 | Scaling experiment and write-up |
| 10 | Chaos testing, deployment, documentation, demo |

## 15. Alternatives considered

| Decision | Alternative | Why not | ADR |
|---|---|---|---|
| TypeScript gateway + Python workers | All Python, or all TypeScript | Python is weaker for my gateway skills; TypeScript lacks the ML ecosystem | [0001](./adr/0001-polyglot-services.md) |
| Redis for registry and cache | etcd, Consul, Memcached | One tool covers cache, registry, and rate limits; simpler to operate | [0002](./adr/0002-redis-for-registry-and-cache.md) |
| Docker Compose first | Kubernetes from day one | Slower iteration; Kubernetes is added later | [0003](./adr/0003-compose-before-kubernetes.md) |
| Separate liveness and readiness | One health endpoint | Can't distinguish "loading" from "broken" | [0004](./adr/0004-separate-liveness-and-readiness.md) |
| Use an existing serving system (KServe, Ray Serve) | Build from scratch | The project's purpose is to understand the internals | — |

## 16. Open questions

- How should the gateway behave when Redis is down: serve without rate limiting, or apply a stricter local in-memory limit?
- Should the prediction cache TTL differ per model?
- What forecast horizon works best for the measured cold-start time? To be decided after Phase 1.
- Which public traffic trace best represents realistic load for the experiment?
- Is a single gateway instance acceptable for the demo, or should two run behind a reverse proxy?
- Should canary analysis use a fixed duration per stage or a minimum number of requests?
