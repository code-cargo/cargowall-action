/**
 * The startup wait: how long the action waits for cargowall to report
 * ready, and the loop that waits.
 *
 * The wait must outlast cargowall's own worst case, or the action gives up,
 * and with `fail-on-unsupported: false` runs the job unfiltered, while
 * cargowall is still starting within its limits. The bounded waits on the
 * pinned cargowall's path to ready (STARTUP_BOUNDS_CHECKED_AGAINST), from
 * its source:
 *
 * - restarting a local Docker daemon onto its DNS settings, 60 s
 *   (`dockerRestartTimeout`, pkg/network/docker.go), after which it warns
 *   and carries on;
 * - the sudo lockdown's checks, 10 s each (`probeTimeout`,
 *   pkg/lockdown/verify.go): the sudo probe, `sudo -n -l` with an
 *   allowlist, and one `test -w` per Docker socket the job's workers can
 *   reach (`warnDockerAccess`: the default socket and each worker's
 *   DOCKER_HOST, two on a runner with one non-default host): 40 s;
 * - the policy fetch, 10 s (`policyFetchTotalBudget`, cmd/api.go);
 * - the DNS proxy binding its listeners, 10 s (cmd/start.go);
 * - the Docker probes in pkg/podenv, 2 s each: the socket's listener
 *   (dockerd.go), up to three daemon requests (`answerWithin`), the
 *   container runtime probe (dockerd.go), the ping (`pingWithBridges`,
 *   dockerup.go) and the unix socket diag (unixdiag.go): 14 s;
 * - the nftables transactions, 2 s each (`nftTimeout`): the redirect's,
 *   the three guard tables' and a retry: 10 s;
 * - listing Docker's networks for the hook's carve-outs, 5 s
 *   (`unaryTimeout`, pkg/containers/network.go);
 * - startup pre-resolution, 5 s (`preResolveDeadline`, cmd/preresolve.go);
 * - flushing systemd-resolved's cache, 5 s and its 1 s `WaitDelay`
 *   (pkg/network/dns_redirect.go);
 * - the conntrack flush, 2 s (`ctFlushTimeout`).
 *
 * About 162 s in all, the counts above being the largest a stock runner
 * reaches. STARTUP_TIMEOUT adds half as much again, for what was not
 * counted and the work between the waits. A `binary-path` or `source-ref`
 * build has bounds of its own that nobody summed.
 *
 * The wait does not cost that long when cargowall fails: it polls every
 * second, and leaves at once on the failure sentinel, on exit status 3, on
 * cargowall's death, and on a launcher that exited before cargowall ever
 * wrote its pidfile (a flag the binary rejects, a sudo or exec failure).
 */

/** The wait, in seconds, measured on the wall clock from the spawn. */
export const STARTUP_TIMEOUT = 240

/**
 * The cargowall release the bounds above were summed from. A test fails
 * when the pin (setup.ts CARGOWALL_VERSION) moves without this, so a pin
 * bump has to recheck the sum.
 */
export const STARTUP_BOUNDS_CHECKED_AGAINST = 'v2.0.0-rc.17'

/** `cargowall start`'s exit status for a refused posture (cmd/postures.go exitRefused). */
export const EXIT_REFUSED = 3

export type Liveness = 'alive' | 'dead' | 'unknown'

/** What the wait reads each second; injected so the loop can be tested on its own. */
export interface WaitProbes<F> {
  /** Whether this run's ready sentinel is there. */
  ready(): Promise<boolean>
  /** This run's failure sentinel, or null. */
  failure(): Promise<F | null>
  /** cargowall's real pid from this run's pidfile, or null. */
  pid(): Promise<number | null>
  liveness(pid: number): Promise<Liveness>
  /** The launcher's exit status once it has exited with one; null before, and for a signal. */
  exitCode(): number | null
  now(): number
  sleep(ms: number): Promise<void>
}

export type WaitOutcome<F> =
  | { kind: 'ready'; pid: number | null }
  | { kind: 'failed'; failure: F }
  /** Exit status 3 with no sentinel: a refusal cargowall could not write down. */
  | { kind: 'refused' }
  /** cargowall's pid was read and it has died, with no sentinel. */
  | { kind: 'died'; pid: number }
  /** The launcher exited before cargowall ever wrote its pidfile. */
  | { kind: 'launcher-exited'; code: number }
  | { kind: 'timeout'; pid: number | null; waitedMs: number }

/**
 * Waits for cargowall to report ready, for timeoutMs of wall clock from
 * startedAtMs.
 *
 * A launcher that exits with a status before any pidfile was seen ends the
 * wait: cargowall writes its pidfile first thing, so it never ran, or died
 * before it could say why. A launcher killed by a signal reports no status,
 * as one torn down with the process tree by the Docker restart does, and
 * the wait goes on. A pidfile once seen hands liveness to the pid.
 */
export async function waitForReady<F>(
  p: WaitProbes<F>,
  startedAtMs: number,
  timeoutMs: number = STARTUP_TIMEOUT * 1000,
): Promise<WaitOutcome<F>> {
  let pid: number | null = null
  for (;;) {
    if (await p.ready()) return { kind: 'ready', pid }
    const failure = await p.failure()
    if (failure !== null) return { kind: 'failed', failure }
    if (p.exitCode() === EXIT_REFUSED) return { kind: 'refused' }

    pid = pid ?? (await p.pid())
    if (pid !== null && (await p.liveness(pid)) === 'dead') {
      // cargowall writes its sentinel, removes its pidfile and exits within
      // milliseconds, so the sentinel can land between the read above and
      // this check: look again before calling the death unexplained.
      const late = await p.failure()
      if (late !== null) return { kind: 'failed', failure: late }
      if (p.exitCode() === EXIT_REFUSED) return { kind: 'refused' }
      return { kind: 'died', pid }
    }
    const code = p.exitCode()
    if (pid === null && code !== null) {
      const late = await p.failure()
      if (late !== null) return { kind: 'failed', failure: late }
      return { kind: 'launcher-exited', code }
    }

    const waited = p.now() - startedAtMs
    if (waited >= timeoutMs) {
      if (p.exitCode() === EXIT_REFUSED) return { kind: 'refused' }
      return { kind: 'timeout', pid: pid ?? (await p.pid()), waitedMs: waited }
    }
    await p.sleep(Math.min(1000, timeoutMs - waited))
  }
}
