# Post-cutover monitoring

The minimum-viable monitoring wired up before cutover. The bar isn't
"observable in detail" — it's "we know within 60 seconds if the site is
down, and within 5 minutes if an error rate is climbing."

Anything fancier (Prometheus metrics, RED-style dashboards, distributed
tracing) is deferred until we have a specific need that justifies the ops
weight — see [specs/deferred.md](../../specs/deferred.md).

> Companion: [cutover.md](cutover.md) (when the monitoring window applies),
> [runbook.md](runbook.md) (what to do when an alarm fires).

## The four signals

| Signal | Source | Target | Action |
|--------|--------|--------|--------|
| Liveness | `/api/health` | UptimeRobot or healthchecks.io | Page on-call if 2 consecutive failures |
| Readiness | `/api/health/ready` | k8s readiness probe + external monitor | Page on-call if pod fails to ready within 90s of boot |
| Log errors | Pino → stdout → cluster log aggregator | Slack `#alerts` webhook | Slack ping on every `level >= 40` (warn+) |
| Push daemon | Periodic Pino log line | Same as above | Slack ping on push failure |

That's it. Four signals; all of them have a Slack-paging story.

## 1. External liveness check

A simple HTTP HEAD-style ping every 60 seconds from outside the cluster.
Two viable providers:

- **healthchecks.io** — free tier, dead-man-switch model. We send a heartbeat
  *to* them; they alarm if heartbeats stop. Less natural for "check this
  URL" usage but free, simple, scriptable.
- **UptimeRobot** — free tier covers 50 monitors at 5-minute intervals;
  paid tier ($7/mo) drops to 1-minute. We want 1-minute.

**Recommended at v1: UptimeRobot.**

Configure two monitors:

| Monitor | URL | Interval | Alert when |
|---------|-----|----------|-----------|
| codeforphilly.org liveness | `https://codeforphilly.org/api/health` | 1 min | 2 consecutive failures (≈ 2 min) |
| codeforphilly.org readiness | `https://codeforphilly.org/api/health/ready` | 5 min | 1 failure (≈ 5 min) |

Both alarm via the UptimeRobot → Slack integration to the `#alerts` channel.

Why two monitors? `/api/health` only checks the Fastify event loop. If the
store decorators are missing (broken boot), `/api/health/ready` will return
503 even though `/api/health` is 200. We want to know about both.

## 2. Kubernetes liveness + readiness probes

These already exist in `deploy/kustomize/base/deployment.yaml` — see [deploy.md probes](deploy.md#probes).
They serve a different purpose than the external monitors: they make k8s
**act** on a bad pod (restart it) rather than just notify us.

The two layers are complementary:

- k8s probes: "is this pod healthy? if not, kill it"
- External monitors: "is the site reachable from the public internet?"

A pod can pass k8s probes but the public hostname can still be unreachable
(ingress misconfigured, cert-manager wedged, DNS broken). The external
monitor catches those.

## 3. Log aggregation

Pino logs go to stdout from the API process. The cluster's log aggregator
(whatever is configured — at minimum `kubectl logs` works; ideally a
shipper to a hosted log store like BetterStack or Grafana Loki) collects
them.

Required log levels in production:

| Level | Numeric | When |
|-------|---------|------|
| `info` | 30 | Normal traffic; routine events |
| `warn` | 40 | Anything we should look at but isn't broken |
| `error` | 50 | Something broke; user-visible |
| `fatal` | 60 | Reserved for boot failures and unrecoverable state |

The webhook to Slack `#alerts` fires on level >= 40. Most days the channel
is silent; on an incident day it's where the team congregates.

### Sampling

When traffic is bursty we don't want to flood Slack. The webhook config
should rate-limit to one message per minute per (logger, message) key,
with a counter appended ("8 occurrences in last 60s").

A v1 webhook implementation: a separate small Node process that consumes
the cluster log stream and sends Slack messages. Stand it up post-cutover
if we don't have one yet; the cutover monitoring window is too short to
justify hand-grepping `kubectl logs`.

## 4. Push-daemon health

The async push from the API process to the data repo's GitHub remote can
fail silently — the user sees their change land locally (we serve from
the in-process state) but it doesn't propagate. Without monitoring this
we'd find out via a contributor noticing the data repo is stale.

The fix is two-layer:

1. In the API's push job, emit `info` on success and `error` on failure.
   The Pino error gets webhooked to Slack like any other.
2. A daily check: "is the data repo's `origin/main` HEAD within 24h of the
   API pod's local HEAD?" Tooling TBD; could be a small `kubectl exec`
   cron or a server-side check exposed at `/api/health/push-daemon`.

For cutover-prep we ship the level-1 layer (push errors are already
loggable). The daily check is deferred to a post-cutover follow-up.

## What we are deliberately NOT monitoring at v1

- **API response time histograms.** Pino logs include a `responseTime` per
  request; if we hit a perf wall, search the logs. No P95/P99 dashboards.
- **Throughput metrics.** Civic scale means a "slow day" and a "busy day"
  look identical to the system. Counting requests is theatrics.
- **Database query latency.** There is no database.
- **Memory + CPU dashboards.** `kubectl top pod` is enough at single-replica
  scale. If we hit OOMKilled, the runbook tells us what to do.
- **User-side performance (RUM).** Bundle size targets are in
  [architecture.md](../../specs/architecture.md#performance-budgets); we
  don't measure them in production.

These are deferred to when we have a specific need, not pre-emptively.

## Pre-cutover monitoring checklist

The cutover lead confirms before T-0:

- [ ] UptimeRobot account exists; two monitors above are configured
- [ ] UptimeRobot → `#alerts` Slack integration is fired by a test alarm
- [ ] k8s liveness + readiness probes are present in `deploy/kustomize/base/deployment.yaml`
- [ ] Log webhook → `#alerts` integration fires on a test `WARN` line
- [ ] On-call rotation is set in PagerDuty / Slack handoff doc
- [ ] At least one team member can reach `#alerts` outside business hours

The "test alarm" step is non-negotiable: untested alerts have a
well-documented tendency to silently not fire when they're needed most.
Trigger each one once in staging and confirm a Slack message arrived.

## Post-cutover: when to add more

Concrete triggers for "we need more monitoring":

- We've hit two incidents where existing tools didn't surface the issue
  fast enough → add a probe / dashboard targeting that gap.
- The org grows beyond ~5000 active members → reconsider whether
  in-memory state + single replica is still adequate; new architecture
  may need Prometheus-style metrics.
- A staff member's manual reconciliation finds drift that the existing
  reconcile script doesn't catch → either extend the script or add a
  specific monitor.

Don't add monitoring pre-emptively. Tools that nobody looks at rot.
