/**
 * The startup wait: how long the action waits for cargowall to report
 * ready, and the loop that waits.
 *
 * The wait must outlast cargowall's own worst case, or the action gives up,
 * and with `fail-on-unsupported: false` runs the job unfiltered, while
 * cargowall is still starting within its limits. STARTUP_BOUNDS lists the
 * bounded waits on the pinned cargowall's path to ready
 * (STARTUP_BOUNDS_CHECKED_AGAINST), from its source, each at the largest
 * count a stock runner reaches; the wait is half as much again, for what
 * was not counted and the work between the waits. A `binary-path` or
 * `source-ref` build has bounds of its own that nobody summed.
 *
 * The wait does not cost that long when cargowall fails: it polls every
 * second, and leaves at once on the failure sentinel, on exit status 3, on
 * cargowall's death, and on a launcher that exited with a status while no
 * live cargowall was seen (a flag the binary rejects, a sudo or exec
 * failure, a cargowall gone before it could say why).
 */

/** The pinned cargowall's bounded startup waits, in seconds. The one place to edit. */
export const STARTUP_BOUNDS: ReadonlyArray<{ wait: string; seconds: number }> = [
  { wait: 'restarting a local Docker daemon (dockerRestartTimeout, pkg/network/docker.go)', seconds: 60 },
  {
    wait: "the sudo lockdown's checks, 10 s each (probeTimeout, pkg/lockdown/verify.go): the sudo probe, " +
      'sudo -n -l with an allowlist, and a test -w for each of two Docker sockets',
    seconds: 40,
  },
  { wait: 'the policy fetch (policyFetchTotalBudget, cmd/api.go)', seconds: 10 },
  { wait: 'the DNS proxy binding its listeners (cmd/start.go)', seconds: 10 },
  {
    wait: "the Docker probes in pkg/podenv, 2 s each: the socket's listener, three daemon requests " +
      '(answerWithin), the runtime probe, the ping (pingWithBridges) and the unix socket diag',
    seconds: 14,
  },
  { wait: 'the nftables transactions, 2 s each (nftTimeout): the redirect, three guard tables, a retry', seconds: 10 },
  { wait: "listing Docker's networks (unaryTimeout, pkg/containers/network.go)", seconds: 5 },
  { wait: 'startup pre-resolution (preResolveDeadline, cmd/preresolve.go)', seconds: 5 },
  { wait: "flushing systemd-resolved's cache, and its WaitDelay (pkg/network/dns_redirect.go)", seconds: 6 },
  { wait: 'the conntrack flush (ctFlushTimeout)', seconds: 2 },
]

/** The sum of STARTUP_BOUNDS, in seconds. */
export const STARTUP_BOUNDS_SECONDS = STARTUP_BOUNDS.reduce((sum, b) => sum + b.seconds, 0)

/** The wait, in seconds, on a monotonic clock from the spawn: the sum and half again, rounded up to 10 s. */
export const STARTUP_TIMEOUT = Math.ceil((STARTUP_BOUNDS_SECONDS * 1.5) / 10) * 10

/**
 * Whether the run asked for an enforcing rung (--container-egress=enforce,
 * a --tls-sni enforce rung) under an enforcing mode: what cargowall itself
 * would refuse to start without, so a cargowall that never came up fails the
 * step whatever fail-on-unsupported says.
 */
export function enforcingRungRequested(postureFlags: readonly string[], mode: string): boolean {
  return mode !== 'audit' && postureFlags.some(f => /^--(container-egress|tls-sni)=enforce/.test(f))
}

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
  /** The launcher exited with a status, and no live cargowall was seen. */
  | { kind: 'launcher-exited'; code: number }
  | { kind: 'timeout'; pid: number | null; waitedMs: number }

/**
 * Waits for cargowall to report ready, for timeoutMs from startedAtMs on
 * p.now's clock, which must be monotonic: a wall-clock step on a freshly
 * provisioned runner would otherwise end or stretch the wait.
 *
 * A launcher that exits with a status ends the wait when no pidfile was
 * seen (cargowall writes its pidfile first thing, so it never ran, or wrote
 * and removed it between polls) or when the pid it names isn't shown alive
 * (liveness is unknown under the sudo lockdown). A launcher killed by a
 * signal reports no status, as one torn down with the process tree by the
 * Docker restart does, and the wait goes on.
 */
export async function waitForReady<F>(
  p: WaitProbes<F>,
  startedAtMs: number,
  timeoutMs: number = STARTUP_TIMEOUT * 1000,
): Promise<WaitOutcome<F>> {
  let pid: number | null = null
  let liveness: Liveness | null = null
  for (;;) {
    if (await p.ready()) return { kind: 'ready', pid }
    const failure = await p.failure()
    if (failure !== null) return { kind: 'failed', failure }
    if (p.exitCode() === EXIT_REFUSED) return { kind: 'refused' }

    pid = pid ?? (await p.pid())
    // An unknown liveness (sudo denied under the lockdown) stays unknown for
    // the rest of startup: no more denied sudo calls once it is known.
    if (pid !== null && liveness !== 'unknown') liveness = await p.liveness(pid)
    if (pid !== null && liveness === 'dead') {
      // cargowall writes its sentinel, removes its pidfile and exits within
      // milliseconds, so the sentinel can land between the read above and
      // this check: look again before calling the death unexplained.
      const late = await p.failure()
      if (late !== null) return { kind: 'failed', failure: late }
      if (p.exitCode() === EXIT_REFUSED) return { kind: 'refused' }
      return { kind: 'died', pid }
    }
    const code = p.exitCode()
    if (code !== null && liveness !== 'alive') {
      const late = await p.failure()
      if (late !== null) return { kind: 'failed', failure: late }
      if (code === EXIT_REFUSED) return { kind: 'refused' }
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
