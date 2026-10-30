# Service Level Objectives

| | |
|---|---|
| **Author** | Syeda Hafsa Anis |
| **Status** | Accepted |
| **Created** | 2026-10-28 |
| **Related** | [Design doc](./design-doc.md) |

## Why these exist

SLOs define what "working well" means, in numbers, before any experiment runs. The main experiment compares autoscaling policies, and "better" only means something against a fixed target. **These targets must not be changed after experiments start.** If a change is ever needed, record it with a new version of this document and a reason, and rerun the affected experiments.

## Terms

- **SLI (Service Level Indicator):** a measurement, e.g. "the 99th-percentile latency over 5 minutes."
- **SLO (Service Level Objective):** a target for an SLI, e.g. "p99 latency below 200 ms."
- **Error budget:** the amount of failure the SLO allows. A 99.5% success target allows 0.5% of requests to fail.

## The SLOs

| # | SLO | Target | Window |
|---|---|---|---|
| 1 | Latency | p99 below **200 ms** | Rolling 5 minutes |
| 2 | Availability | at least **99.5%** of requests succeed | Each experiment run |
| 3 | Scaling reaction | capacity shortfall lasts under **60 seconds** | Each traffic spike |

## SLO 1: Latency

**Target:** 99% of prediction requests complete in under 200 ms, measured over rolling 5-minute windows.

**How it's measured:** at the gateway, from request received to response sent. This includes cache hits, batching delay, and worker time, because that's what the client experiences.

```promql
histogram_quantile(0.99,
  sum(rate(gateway_request_duration_seconds_bucket{route="predict"}[5m])) by (le))
```

**Why 200 ms:** the models are small tabular models, so inference itself should take a few milliseconds. 200 ms leaves room for network hops, the 10 ms batching window, and one retry, while still feeling instant to a user. A tighter target would mostly measure Docker networking on one machine; a looser one would hide real queueing problems during spikes.

**Why p99 and not average:** averages hide the slow requests that users notice. During a traffic spike, the average may look fine while 1 in 50 users waits seconds.

**SLI for the experiment:** *SLO violation minutes*, the number of 1-minute intervals in which p99 latency exceeded 200 ms.

## SLO 2: Availability

**Target:** at least 99.5% of valid prediction requests succeed.

**What counts as a failure:**

| Response | Counted as failure? | Reason |
|---|---|---|
| 2xx | No | Success |
| 400, 401, 404 | No (excluded) | The client's fault, not the system's |
| 429 from per-client rate limit | No (excluded) | Intended protection against one client |
| 503 from load shedding or no workers | **Yes** | The system couldn't serve |
| 504 timeout, other 5xx | **Yes** | The system failed |

```promql
1 - (
  sum(rate(gateway_requests_total{route="predict", status=~"5.."}[5m]))
  /
  sum(rate(gateway_requests_total{route="predict", status!~"4.."}[5m]))
)
```

**Error budget:**

| Run | Total requests | Allowed failures (0.5%) |
|---|---|---|
| 1 hour at 100 RPS average | 360,000 | 1,800 |
| 1 hour at 500 RPS average | 1,800,000 | 9,000 |

**Why 99.5%:** it's strict enough that a policy that drops requests during every spike will fail it, but realistic for a single-machine system with intentional chaos testing. Production services often target 99.9% or higher; this project runs on one machine and deliberately kills components, so 99.5% is a fair target for its scope.

## SLO 3: Scaling reaction

**Target:** when demand exceeds available capacity, the shortfall lasts less than 60 seconds.

**Definitions:**
- `C` = benchmarked capacity of one worker (from Phase 1).
- **Capacity shortfall** = any moment when `actual_rps > ready_workers × C`.
- **Shortfall duration** = how long a continuous shortfall lasts.

```promql
sum(rate(gateway_requests_total{route="predict"}[1m]))
  > on() (sum(autoscaler_ready_replicas) * <C>)
```

**Why 60 seconds:** with a simulated cold start of 20–30 seconds, a well-tuned reactive policy should just barely meet this on gradual ramps and miss it on sudden spikes. Predictive scaling should meet it on predictable spikes. This target is chosen so the experiment can actually tell the policies apart.

## Secondary metrics (not SLOs, but reported)

These are measured in every experiment to show the tradeoff between reliability and cost:

| Metric | Why it matters |
|---|---|
| **Worker-minutes** | Cost. A policy that meets every SLO by running 20 workers all day isn't a good policy. |
| **Scaling events** | Stability. Many up/down changes in a short period (flapping) is a sign of a bad policy. |
| **Time to recover after a spike** | How quickly latency returns under target. |
| **Forecast error and under-prediction rate** | How good the forecast was, and how often it guessed too low. |

## How the SLOs are used

1. **Experiments:** every policy run reports SLO 1 violation minutes, SLO 2 success rate, SLO 3 shortfall durations, and the secondary metrics.
2. **Canary analysis:** a canary version fails if it would push latency or error rates past these targets.
3. **Dashboards:** Grafana shows each SLI against its target line.
4. **Design decisions:** when choosing timeouts, batch windows, or retry counts, they must fit within the 200 ms latency budget.

## Assumptions

- Load testing and services share one machine, so the load generator's own CPU use can affect results. Experiments note the machine spec.
- Cold start is simulated with a configurable delay, and results are reported for several delay values.
- `C` is measured once per model and hardware setup, and is re-measured if either changes.

## Change log

| Version | Date | Change |
|---|---|---|
| 1.0 | 2026-10-28 | Initial SLOs |
