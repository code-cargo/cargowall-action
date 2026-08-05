import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as github from '@actions/github'
import { spawn } from 'child_process'
import { promises as fs } from 'fs'
import { closeSync, openSync, constants as fsConstants } from 'fs'
import * as path from 'path'
import { detectDnsUpstream } from './dns'
import { findDiagDir, parseExecutedSteps, parseJobPlan } from './diag'

const AUDIT_LOG = '/tmp/cargowall-audit.json'
const CARGOWALL_LOG = '/tmp/cargowall.log'
const READY_FILE = '/tmp/cargowall-ready'
const PID_FILE = '/tmp/cargowall.pid'
// FAILURE_FILE is written by cargowall on any fatal startup error, including
// the policy lockdown from --api-failure-mode=fail. DOWNGRADE_FILE is its
// structured record of a posture change, and tells those two apart. Both paths
// are shared with the Go binary — keep them in sync.
const FAILURE_FILE = '/tmp/cargowall-failed'
const DOWNGRADE_FILE = '/tmp/cargowall-downgrade'
const RESOLV_CONF_BACKUP = '/etc/resolv.conf.cargowall.bak'
const STARTUP_TIMEOUT = 30
const STEP_PLAN_FILE = '/tmp/cargowall-step-plan.json'
const STEP_TIMESTAMPS_FILE = '/tmp/cargowall-step-timestamps.jsonl'

const VALID_MODES = ['enforce', 'audit'] as const

async function showLastLog(): Promise<void> {
  try {
    let logOutput = ''
    await exec.exec('tail', ['-50', CARGOWALL_LOG], {
      ignoreReturnCode: true,
      listeners: {
        stdout: (data: Buffer) => { logOutput += data.toString() }
      }
    })
    if (logOutput) core.info(`Last log output:\n${logOutput}`)
  } catch { /* ignore */ }
}

export async function start(): Promise<{ supported: boolean; pid: number | null }> {
  // `mode` carries no default in action.yml, so an empty value means the caller
  // did not ask for a mode — which is what lets resolveApiFailureMode tell an
  // explicit `mode: enforce` apart from the default one. Only a VALID value
  // counts as supplied: a typo'd mode falls back to enforce as a lenient
  // recovery, not a user instruction, and treating it as "explicitly asked to
  // enforce" would also suppress the api-failure-mode audit default.
  const modeInput = core.getInput('mode')
  const modeSupplied = VALID_MODES.includes(modeInput as typeof VALID_MODES[number])
  let mode = modeInput || 'enforce'

  if (!VALID_MODES.includes(mode as typeof VALID_MODES[number])) {
    core.warning(`Invalid mode "${mode}" — expected "enforce" or "audit". Defaulting to "enforce".`)
    mode = 'enforce'
  }
  const allowedHosts = parseList(core.getMultilineInput('allowed-hosts'))
  const allowedCidrs = parseList(core.getMultilineInput('allowed-cidrs'))
  const searchDomains = parseList(core.getMultilineInput('search-domains'))
  const githubServiceHosts = requireNonEmptyHostList('github-service-hosts')
  const azureInfraHosts = requireNonEmptyHostList('azure-infra-hosts')

  const configFile = core.getInput('config-file')
  const sudoLockdown = core.getInput('sudo-lockdown') === 'true'
  const debug = core.getInput('debug') === 'true'
  const failOnUnsupported = core.getInput('fail-on-unsupported') === 'true'
  const allowExistingConnections = core.getInput('allow-existing-connections') !== 'false'

  core.startGroup('Starting CargoWall Firewall')

  // Start the block file watcher as early as possible.
  // Block files get cleaned up during the run, so the watcher must capture
  // timestamps in real-time. Starting it before binary download gives it
  // the full setup duration (~8-10s) to capture earlier steps' block files.
  try {
    const diagDir = await findDiagDir()
    if (diagDir) {
      core.saveState('diag-dir', diagDir)

      // Try to parse and persist the step plan if available
      try {
        const stepPlan = await parseJobPlan(diagDir)
        if (Object.keys(stepPlan).length > 0) {
          await fs.writeFile(STEP_PLAN_FILE, JSON.stringify(stepPlan))
          core.info(`Step plan: ${Object.keys(stepPlan).length} steps mapped`)
        } else {
          core.info('Step plan is empty or unavailable; proceeding without mapped steps.')
        }
      } catch (planErr) {
        core.info(`Unable to parse step plan: ${planErr}`)
      }

      // Save the current step name so the post step knows where CW started.
      // This must run regardless of whether the plan parsed successfully,
      // because buildStepsFromDiag needs it even without a plan.
      try {
        const executedSoFar = await parseExecutedSteps(diagDir)
        if (executedSoFar.length > 0) {
          core.saveState('cw-step-name', executedSoFar[executedSoFar.length - 1])
        }
      } catch {
        // Worker log may not be available yet — not critical
      }

      // Spawn watcher as detached node process.
      // Must run whenever diagDir exists so timestamps are available
      // even if the step plan is empty or could not be parsed.
      const blocksDir = path.join(diagDir, 'blocks')
      const watcherScript = path.join(__dirname, '..', 'watcher', 'index.js')
      const watcher = spawn('node', [watcherScript, blocksDir, STEP_TIMESTAMPS_FILE], {
        detached: true,
        stdio: 'ignore',
      })
      watcher.unref()
      if (watcher.pid) {
        core.saveState('watcher-pid', String(watcher.pid))
        core.info(`Blocks watcher started (PID: ${watcher.pid})`)
      }
    }
  } catch (err) {
    core.info(`Sub-second timestamp setup: ${err}`)
  }

  // Auto-detect DNS upstream before we overwrite resolv.conf
  const dnsResult = await detectDnsUpstream(core.getInput('dns-upstream'))
  const dnsUpstream = dnsResult.primary

  // Build cargowall arguments.
  // --pidfile lets cargowall record its own (real) PID so we can track the
  // actual process rather than the `sudo` wrapper we spawn. --ready-file is
  // passed explicitly so the sentinel path stays pinned even if the binary's
  // default changes.
  const args: string[] = [
    'start',
    '--github-action',
    `--dns-upstream=${dnsUpstream}`,
    `--pidfile=${PID_FILE}`,
    `--ready-file=${READY_FILE}`,
    `--failure-file=${FAILURE_FILE}`,
    // Always collected. `audit-summary` decides whether the summary is
    // *rendered* into the workflow run summary, not whether events exist:
    // the audit log also feeds the dashboard's per-step detail, and gating
    // collection on a rendering preference made audit-summary:false jobs
    // invisible to the SaaS entirely (#71).
    `--audit-log=${AUDIT_LOG}`,
  ]

  if (mode === 'audit') {
    args.push('--audit-mode')
    core.notice('CargoWall running in AUDIT MODE - connections logged but NOT blocked')
  }

  if (debug) {
    args.push('--debug')
  }

  if (sudoLockdown) {
    args.push('--sudo-lockdown')
    const sudoAllowCommands = parseList(core.getMultilineInput('sudo-allow-commands'))
    if (sudoAllowCommands) {
      args.push(`--sudo-allow-commands=${sudoAllowCommands}`)
    }
  }

  if (allowExistingConnections) {
    args.push('--allow-existing-connections')
  }

  // When api-url is configured and offline mode is not enabled, fetch OIDC
  // token and pass API flags so the Go binary can fetch the resolved policy
  // from the CodeCargo SaaS API.
  const offline = core.getInput('offline') === 'true'
  const apiUrl = core.getInput('api-url')
  // Non-null only while the API flags survive, so the configuration log never
  // advertises a posture that was dropped along with them below.
  let apiFailureLabel: string | null = null
  if (apiUrl && !offline) {
    args.push(`--api-url=${apiUrl}`)
    args.push(`--job-key=${github.context.job}`)
    const apiFailure = resolveApiFailureMode({
      input: core.getInput('api-failure-mode'),
      modeSupplied,
    })
    args.push(`--api-failure-mode=${apiFailure.value}`)
    apiFailureLabel = `${apiFailure.value} (${apiFailure.reason})`
    try {
      const idToken = await core.getIDToken('codecargo')
      args.push(`--token=${idToken}`)
    } catch (error) {
      // No token means no fetch is even attempted, so this is not a retrieval
      // failure and must not trigger the api-failure-mode posture — it is a
      // workflow misconfiguration, handled the same way cargowall handles a
      // rejected token. Drop the API flags so the binary uses env/file config.
      core.warning(
        `Failed to get OIDC token for policy fetch: ${error}. ` +
          `Ensure the workflow has "permissions: id-token: write". ` +
          `Falling back to this step's configuration (api-failure-mode does not apply).`
      )
      for (const flag of ['--api-url', '--job-key', '--api-failure-mode']) {
        const idx = args.findIndex(a => a.startsWith(`${flag}=`))
        if (idx !== -1) args.splice(idx, 1)
      }
      apiFailureLabel = null
    }
  }

  if (configFile) {
    args.push(`--config=${configFile}`)
  }

  // Log configuration
  core.info('Configuration:')
  core.info(`  Mode: ${mode}`)
  if (allowedHosts) core.info(`  Allowed hosts: ${allowedHosts}`)
  if (allowedCidrs) core.info(`  Allowed CIDRs: ${allowedCidrs}`)
  if (searchDomains) core.info(`  Search domains: ${searchDomains}`)
  if (githubServiceHosts) core.info(`  GitHub service hosts: ${githubServiceHosts}`)
  if (azureInfraHosts) core.info(`  Azure infra hosts: ${azureInfraHosts}`)
  if (configFile) core.info(`  Config file: ${configFile}`)
  const jobId = core.getInput('job-id')
  if (jobId) core.info(`  Job run ID: ${jobId}`)
  core.info(`  Sudo lockdown: ${sudoLockdown}`)
  core.info(`  DNS upstream: ${dnsUpstream}`)
  if (apiFailureLabel) core.info(`  Policy-fetch failure posture: ${apiFailureLabel}`)

  // Backup current resolv.conf
  try {
    await fs.access('/etc/resolv.conf')
    await exec.exec('sudo', ['cp', '/etc/resolv.conf', RESOLV_CONF_BACKUP])
    core.info('Backed up /etc/resolv.conf')
  } catch {
    // resolv.conf doesn't exist, skip backup
  }

  // Configure DNS to use cargowall's proxy
  core.info('Configuring DNS to use cargowall proxy...')
  try {
    await exec.exec('bash', ['-c', 'echo "nameserver 127.0.0.1" | sudo tee /etc/resolv.conf > /dev/null'])
  } catch (err) {
    core.warning(`Failed to overwrite /etc/resolv.conf: ${err}`)
    await restoreDns()
  }

  // Start cargowall in the background
  core.info('Starting cargowall...')

  // Clear any stale ready/pid files from a prior run on a reused (e.g.
  // self-hosted) runner. Otherwise a leftover ready sentinel would short-circuit
  // the wait, and a stale pidfile pointing at a dead PID would trip the liveness
  // check as a false "exited unexpectedly". Best-effort and root-owned, so sudo.
  await clearStartupFiles()

  // Set environment variables for cargowall
  const env = {
    ...process.env,
    CARGOWALL_DEFAULT_ACTION: 'deny',
    ...(allowedHosts && { CARGOWALL_ALLOWED_HOSTS: allowedHosts }),
    ...(allowedCidrs && { CARGOWALL_ALLOWED_CIDRS: allowedCidrs }),
    ...(searchDomains && { CARGOWALL_SEARCH_DOMAINS: searchDomains }),
    // Always set: requireNonEmptyHostList guarantees these are non-empty, and omitting
    // them would hand cargowall's narrower built-in defaults to the user unannounced.
    CARGOWALL_GITHUB_SERVICE_HOSTS: githubServiceHosts,
    CARGOWALL_AZURE_INFRA_HOSTS: azureInfraHosts,
  }

  const logFd = openSync(CARGOWALL_LOG, 'w')
  const child = spawn('sudo', ['-E', 'cargowall', ...args], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env,
  })
  child.unref()
  closeSync(logFd)

  const spawnedPid = child.pid
  if (!spawnedPid) {
    throw new Error('Failed to start cargowall process')
  }

  core.info(`CargoWall launcher started (PID: ${spawnedPid})`)

  // Wait for cargowall to be ready.
  //
  // Liveness is intentionally NOT based on the spawned `sudo` wrapper PID: under
  // the --github-action preset cargowall restarts the Docker daemon during
  // startup (to apply container DNS config), which tears down and re-parents the
  // process tree we launched. Polling that PID yields false "exited" verdicts even
  // though cargowall comes up and filters fine. Instead we wait for the ready
  // sentinel and, once cargowall has written its own pidfile (just before the
  // sentinel), use that real PID — a dead real PID is a genuine crash. Under
  // --sudo-lockdown liveness is unobservable (sudo is denied), so we just wait
  // for the sentinel/timeout rather than risk a false crash verdict.
  core.info('Waiting for cargowall to initialize...')

  let cargowallPid: number | null = null
  let ready = false
  for (let i = 0; i < STARTUP_TIMEOUT; i++) {
    try {
      await fs.access(READY_FILE)
      ready = true
      break
    } catch {
      // Not ready yet
    }

    // cargowall reported a startup failure. Two very different situations
    // share this sentinel — see isPolicyLockdown.
    const failureReason = await readFailureFile()
    if (failureReason !== null) {
      await showLastLog()
      if (await isPolicyLockdown()) {
        return handlePolicyLockdown(failureReason)
      }
      // A fatal startup error: cargowall has exited. Same contract as the
      // "exited unexpectedly" branch below — honour fail-on-unsupported —
      // but with the binary's own reason instead of a guess.
      core.error(`CargoWall reported a startup failure: ${failureReason}`)
      return handleStartupFailure(
        `CargoWall failed to start. Network filtering is not active. ${failureReason}`,
        `CargoWall failed to start: ${failureReason}`,
        failOnUnsupported,
      )
    }

    cargowallPid = cargowallPid ?? await readPidFile()
    if (cargowallPid !== null && (await processLiveness(cargowallPid)) === 'dead') {
      core.error('CargoWall process exited unexpectedly')
      await showLastLog()
      return handleStartupFailure(
        'CargoWall failed to start. Network filtering is not active.',
        'CargoWall failed to start',
        failOnUnsupported,
      )
    }

    await sleep(1000)
  }

  if (!ready) {
    core.error('Timeout waiting for cargowall to be ready')
    await showLastLog()
    await stopCargowall([cargowallPid ?? await readPidFile(), spawnedPid])
    return handleStartupFailure(
      'CargoWall timed out. Network filtering is not active.',
      'CargoWall timed out starting up',
      failOnUnsupported,
    )
  }

  core.info('CargoWall is ready')

  // Surface a posture change (e.g. --api-failure-mode=audit downgraded the run)
  // now that startup succeeded. Deliberately after the ready check: a lockdown
  // exits above, so anything recorded here belongs to a run that came up.
  await warnOnDowngrade()

  // Resolve cargowall's real PID (written via --pidfile, just before the ready
  // sentinel) for the `pid` output and cleanup state. Fall back to the launcher
  // PID if the pidfile can't be read.
  cargowallPid = cargowallPid ?? await readPidFile()
  const reportedPid = cargowallPid ?? spawnedPid

  core.setOutput('supported', 'true')
  core.setOutput('pid', reportedPid)

  // Persist for the post step (also signals that cargowall was started).
  core.saveState('cargowall-pid', String(reportedPid))

  core.endGroup()

  core.notice('CargoWall firewall is active. Network egress is being filtered.')

  // Show initial debug log
  if (debug) {
    core.startGroup('CargoWall Debug Log')
    try {
      await exec.exec('tail', ['-20', CARGOWALL_LOG], { ignoreReturnCode: true })
    } catch { /* ignore */ }
    core.endGroup()
  }

  return { supported: true, pid: reportedPid }
}

type Liveness = 'alive' | 'dead' | 'unknown'

/**
 * Liveness of a root-owned PID. An unprivileged `kill -0` of a root process
 * returns EPERM even while it's alive, so the check needs sudo. Under
 * --sudo-lockdown the action's sudo is denied — we then can't observe liveness
 * at all and must return 'unknown' rather than misreport a crash. PID 1 is the
 * control: it always exists, so a failing `sudo kill -0 1` means sudo itself is
 * unavailable (lockdown), not that our process died.
 */
async function processLiveness(pid: number): Promise<Liveness> {
  if (await sudoKillZero(pid)) return 'alive'
  // The PID check failed: either the process is gone, or sudo is locked down.
  if (!(await sudoKillZero(1))) return 'unknown'
  return 'dead'
}

/**
 * `sudo -n kill -0 <pid>` — true when it exits 0 (process exists and is
 * signalable). `-n` (non-interactive) is essential: this runs every loop
 * iteration, and under --sudo-lockdown a non-allowed `sudo` would otherwise
 * prompt for a password and hang on the action's empty stdin. With `-n` it
 * fails fast instead, which processLiveness reads as "can't tell" (PID 1 probe).
 */
async function sudoKillZero(pid: number): Promise<boolean> {
  const rc = await exec.exec('sudo', ['-n', 'kill', '-0', String(pid)], {
    ignoreReturnCode: true,
    silent: true,
  })
  return rc === 0
}

/**
 * Read cargowall's real PID from the pidfile it writes via --pidfile. cargowall
 * writes it world-readable (0644), so we read it directly without sudo — which
 * also means this keeps working under --sudo-lockdown, where the action's sudo
 * is denied. Returns null if absent/unreadable (e.g. cargowall hasn't reached
 * the pidfile write yet).
 */
async function readPidFile(): Promise<number | null> {
  try {
    const out = await fs.readFile(PID_FILE, 'utf8')
    const pid = parseInt(out.trim(), 10)
    return Number.isInteger(pid) && pid > 0 ? pid : null
  } catch {
    return null
  }
}

/**
 * Best-effort removal of stale ready/pid files left by a prior run in the same
 * (reused) runner, so this launch's readiness/liveness checks only react to files
 * this cargowall writes. The files may be root-owned, so remove via sudo.
 */
async function clearStartupFiles(): Promise<void> {
  const rc = await exec.exec('sudo', ['rm', '-f', READY_FILE, PID_FILE, FAILURE_FILE, DOWNGRADE_FILE], {
    ignoreReturnCode: true,
    silent: true,
  })
  // Not silent on failure: these files gate the readiness loop, and a stale
  // sentinel that survives here could be misread as this run's verdict.
  if (rc !== 0) {
    core.warning(
      'Failed to clear stale cargowall state files from a previous run — ' +
        'a leftover ready/failure sentinel may be misattributed to this run.'
    )
  }
}

/**
 * Extract the human-readable reason from a failure sentinel. cargowall writes
 * `pid=<n>\n<reason>\n` (cmd/start.go writeFailureSentinel) — the pid stamp
 * exists for wait-ready's freshness check, not for display, and cargowall's
 * own consumer drops it before rendering (cmd/wait_ready.go sentinelReason).
 * Mirror that: cut the pid line, strip control characters (the file lives in
 * world-writable /tmp and this text reaches CI logs), bound the result, and
 * never return empty.
 */
export function sentinelReason(raw: string): string {
  let body = raw
  const nl = raw.indexOf('\n')
  if (nl !== -1 && raw.slice(0, nl).trim().startsWith('pid=')) {
    body = raw.slice(nl + 1)
  }
  // eslint-disable-next-line no-control-regex
  const reason = body.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 4096)
  return reason || 'cargowall reported a startup failure with no reason recorded'
}

/**
 * Read cargowall's failure sentinel. It is written for any fatal startup error,
 * and also when --api-failure-mode=fail puts the runner into policy lockdown —
 * the latter is why we poll for it at all: in lockdown cargowall deliberately
 * withholds the ready sentinel and keeps running deny-all, so the wait loop
 * would otherwise sit out the full timeout for a decision already made.
 * Returns the reason, or null if absent.
 */
async function readFailureFile(): Promise<string | null> {
  const raw = await readStateFile(FAILURE_FILE)
  return raw === null ? null : sentinelReason(raw)
}

/**
 * Bounded, symlink-refusing read of a cargowall state file. These live at
 * fixed paths in world-writable /tmp, so mirror the binary's own reader
 * (cmd/wait_ready.go readStateFile): refuse to follow symlinks, require a
 * regular file, and cap the read — a planted link or oversized file must not
 * be followed or slurped.
 */
const MAX_STATE_FILE_BYTES = 8192

async function readStateFile(filePath: string): Promise<string | null> {
  let handle: Awaited<ReturnType<typeof fs.open>>
  try {
    handle = await fs.open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  } catch {
    return null
  }
  try {
    if (!(await handle.stat()).isFile()) return null
    const buf = Buffer.alloc(MAX_STATE_FILE_BYTES)
    const { bytesRead } = await handle.read(buf, 0, MAX_STATE_FILE_BYTES, 0)
    return buf.toString('utf8', 0, bytesRead)
  } catch {
    return null
  } finally {
    await handle.close()
  }
}

/** Read the downgrade record, or null when cargowall recorded no posture change. */
async function readDowngradeFile(): Promise<string | null> {
  return readStateFile(DOWNGRADE_FILE)
}

/**
 * Distinguish the two states behind the failure sentinel: policy lockdown
 * (cargowall alive, holding the runner at deny-all, an explicitly requested
 * outcome) from any other fatal startup error (cargowall gone, filtering
 * absent). They need opposite handling — the first must always fail the step,
 * the second must keep honouring `fail-on-unsupported` — so classify on the
 * structured downgrade record rather than on the reason text.
 *
 * Anything unreadable reads as "not lockdown", which routes to the pre-existing
 * startup-failure handling rather than newly failing a build.
 */
export function isLockdownRecord(raw: string | null): boolean {
  if (raw === null) return false
  try {
    return (JSON.parse(raw) as { type?: string }).type === 'CARGO_WALL_DOWNGRADE_TYPE_LOCKDOWN'
  } catch {
    return false
  }
}

/**
 * The human-readable half of a downgrade record. Falls back to the raw payload
 * so an unparseable record still tells the user their posture changed — losing
 * that notice is worse than printing JSON at them.
 */
export function downgradeMessage(raw: string | null): string | null {
  if (raw === null) return null
  let detail: string | undefined
  try {
    detail = (JSON.parse(raw) as { detail?: string }).detail
  } catch {
    // Fall through to the raw payload.
  }
  if (detail) return `CargoWall changed enforcement posture: ${detail}`
  // Unparseable record: echo a sanitized, tightly bounded excerpt — enough to
  // recognise, not a vehicle for arbitrary /tmp content in the annotation.
  // eslint-disable-next-line no-control-regex
  const trimmed = raw.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, 512)
  if (!trimmed) return null
  return `CargoWall changed enforcement posture during startup: ${trimmed}`
}

/**
 * Classify a failure sentinel. Both paths write the sentinel immediately before
 * their next step — the downgrade record on one, process exit on the other — so
 * wait briefly for that adjacent write to land before deciding.
 */
async function isPolicyLockdown(): Promise<boolean> {
  await sleep(250)
  return isLockdownRecord(await readDowngradeFile())
}

/**
 * Report a posture change cargowall recorded during startup. Best-effort: a run
 * that filtered correctly must not fail over a reporting artifact.
 */
async function warnOnDowngrade(): Promise<void> {
  const message = downgradeMessage(await readDowngradeFile())
  if (message) core.warning(message)
}

/** Best-effort SIGTERM to cargowall (real PID and/or launcher PID). */
async function stopCargowall(pids: Array<number | null>): Promise<void> {
  for (const pid of pids) {
    if (pid == null) continue
    await exec.exec('sudo', ['kill', String(pid)], { ignoreReturnCode: true, silent: true })
  }
}

/**
 * Shared handling for a failed/timed-out startup: either throw (when
 * fail-on-unsupported) or warn and mark unsupported. Always restore DNS first —
 * resolv.conf was repointed at 127.0.0.1 (cargowall's proxy) during startup, and
 * cargowall isn't running, so leaving it would break DNS for subsequent jobs on
 * a reused/self-hosted runner. Must happen on the throw path too.
 */
async function handleStartupFailure(
  warnMessage: string,
  throwMessage: string,
  failOnUnsupported: boolean,
): Promise<{ supported: boolean; pid: number | null }> {
  await restoreDns()
  if (failOnUnsupported) {
    core.endGroup()
    throw new Error(throwMessage)
  }
  core.warning(warnMessage)
  core.setOutput('supported', 'false')
  core.endGroup()
  return { supported: false, pid: null }
}

/**
 * Handle `--api-failure-mode=fail`: cargowall could not retrieve a policy and
 * has locked the runner down to deny-all.
 *
 * Always throws, regardless of `fail-on-unsupported` — that input is about eBPF
 * support on the runner, whereas reaching here means the caller explicitly asked
 * for the build to fail when the policy is unavailable.
 *
 * Deliberately does not restore DNS or stop cargowall. The lockdown is meant to
 * hold for the rest of the job: cargowall stays alive serving DNS on 127.0.0.1
 * and proceeds to lock the runner down, so restoring resolv.conf would point
 * name resolution back at the upstream mid-lockdown — a confusing
 * half-dismantled state rather than the fail-closed one that was asked for.
 *
 * Future tense on purpose: the sentinel is published at the decision, before
 * the TC attach (cmd/start.go documents it must be read as "cargowall will
 * lock down and will never become ready", not "deny-all is already enforcing").
 * DNS filtering is already refusing non-allowed hostnames in that window.
 */
function handlePolicyLockdown(reason: string): never {
  core.setOutput('supported', 'false')
  core.endGroup()
  throw new Error(
    `${reason} CargoWall stays alive and is locking this runner down to deny-all; ` +
      `egress will remain blocked for the rest of the job.`
  )
}

async function restoreDns(): Promise<void> {
  try {
    await fs.access(RESOLV_CONF_BACKUP)
    await exec.exec('sudo', ['cp', RESOLV_CONF_BACKUP, '/etc/resolv.conf'])
  } catch {
    // No backup to restore
  }
}

/** cargowall's spelling of the three postures, plus how we got there. */
export interface ApiFailureModeResolution {
  value: 'audit' | 'local' | 'fail'
  reason: string
}

/**
 * Resolve the `--api-failure-mode` value handed to cargowall.
 *
 * The action's vocabulary is `audit | enforce | fail`; the binary calls the
 * middle one `local`, because "enforce" here means "this step's own policy",
 * which is *audit* when the step says `mode: audit`. Only the documented
 * values are accepted — the binary's `local` spelling is a translation
 * target, not an input alias.
 *
 * The default is `audit`: for policies managed on the CodeCargo platform, the
 * fail-safe posture on a retrieval failure is to log rather than enforce,
 * keeping the build green and the degradation visible on the dashboard. The
 * trade-off is documented in the README — a retrieval failure means
 * logging-only, and that includes runners that can never reach the API, so
 * non-platform users should set `enforce` (or `offline: true`). The default
 * yields to an explicit `mode`: a caller who wrote `mode: enforce` asked for
 * enforcement in so many words, and downgrading them on an outage would
 * override an instruction they actually gave. An explicitly supplied
 * `api-failure-mode` always wins over both.
 *
 * `modeSupplied` is only knowable because `mode` declares no default in
 * action.yml — the runner materialises defaults into INPUT_* indistinguishably
 * from caller-supplied values. Callers must pass true only for a valid `mode`
 * value: an invalid one falls back to enforce as a lenient recovery, which is
 * not an instruction worth deferring to.
 */
export function resolveApiFailureMode(args: { input: string; modeSupplied: boolean }): ApiFailureModeResolution {
  const input = args.input.trim().toLowerCase()

  if (input === '') {
    return args.modeSupplied
      ? { value: 'local', reason: 'default, deferring to the explicitly set `mode`' }
      : { value: 'audit', reason: 'default' }
  }

  switch (input) {
    case 'audit':
      return { value: 'audit', reason: 'set by `api-failure-mode`' }
    case 'enforce':
      return { value: 'local', reason: 'set by `api-failure-mode`' }
    case 'fail':
      return { value: 'fail', reason: 'set by `api-failure-mode`' }
  }

  // Deliberately fatal rather than warn-and-default like `mode`: this input
  // decides what happens to enforcement during an API outage, and a typo
  // would otherwise surface as a silent posture change during a rare remote
  // failure instead of immediately at configuration time.
  throw new Error(
    `Invalid "api-failure-mode" value "${args.input}" — expected "audit", "enforce", or "fail".`
  )
}

/**
 * Parse an auto-allow host list that carries a non-empty default in action.yml.
 *
 * Clearing such an input does not disable the auto-allow — the action would omit
 * the env var and cargowall would silently fall back to its own built-in list,
 * which is narrower than ours. Since the default is non-empty, an empty result
 * here can only mean the caller deliberately cleared it, so reject it.
 */
export function requireNonEmptyHostList(name: string): string {
  const hosts = parseList(core.getMultilineInput(name))
  if (hosts === '') {
    throw new Error(
      `"${name}" was set to an empty value. This does not disable the auto-allowed hosts — ` +
        `cargowall falls back to its own built-in defaults, which are narrower than this action's. ` +
        `Remove the input to use the defaults, or list the hostnames you want.`
    )
  }
  return hosts
}

/** Split on both newlines (handled by getMultilineInput) and commas, trim, drop empties. */
function parseList(lines: string[]): string {
  return lines
    .flatMap(line => line.split(','))
    .map(entry => entry.trim())
    .filter(Boolean)
    .join(',')
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
