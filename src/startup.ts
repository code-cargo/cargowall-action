/**
 * How long the action waits for cargowall to report ready, in seconds.
 *
 * It must outlast cargowall's own worst case, or the action gives up, and
 * with `fail-on-unsupported: false` runs the job unfiltered, while cargowall
 * is still starting within its limits. The bounded waits on the pinned
 * cargowall's (v2.0.0-rc.17) path to ready:
 *
 * - restarting a local Docker daemon onto its DNS settings, 60 s
 *   (`dockerRestartTimeout`, pkg/network/docker.go), after which it warns
 *   and carries on;
 * - the policy fetch, 10 s (`policyFetchTotalBudget`, cmd/api.go);
 * - the DNS proxy binding its listeners, 10 s (cmd/start.go);
 * - the sudo lockdown's probe, 10 s (`probeTimeout`, pkg/lockdown/verify.go);
 * - startup pre-resolution, 5 s (`preResolveDeadline`, cmd/preresolve.go);
 * - flushing systemd-resolved's cache, 5 s (`flushResolvedTimeout`,
 *   pkg/network/dns_redirect.go);
 * - the Docker probes, 2 s and 2 s (pkg/podenv dockerd.go, dockerup.go);
 * - the nftables and conntrack writes, 2 s each.
 *
 * 108 s in all; 120 s leaves room for the work between them. A real failure
 * still ends the wait at once: the loop polls every second for the failure
 * sentinel and for cargowall's death. Recheck the sum when moving the pin.
 */
export const STARTUP_TIMEOUT = 120
