import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as github from '@actions/github'
import { spawn } from 'child_process'
import { promises as fs } from 'fs'
import { closeSync, openSync } from 'fs'
import * as path from 'path'
import { detectDnsUpstream } from './dns'
import { findDiagDir, parseExecutedSteps, parseJobPlan } from './diag'

const AUDIT_LOG = '/tmp/cargowall-audit.json'
const CARGOWALL_LOG = '/tmp/cargowall.log'
const READY_FILE = '/tmp/cargowall-ready'
const PID_FILE = '/tmp/cargowall.pid'
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
  let mode = core.getInput('mode') || 'enforce'

  if (!VALID_MODES.includes(mode as typeof VALID_MODES[number])) {
    core.warning(`Invalid mode "${mode}" — expected "enforce" or "audit". Defaulting to "enforce".`)
    mode = 'enforce'
  }
  const allowedHosts = parseList(core.getMultilineInput('allowed-hosts'))
  const allowedCidrs = parseList(core.getMultilineInput('allowed-cidrs'))
  const searchDomains = parseList(core.getMultilineInput('search-domains'))
  const githubServiceHosts = parseList(core.getMultilineInput('github-service-hosts'))
  const azureInfraHosts = parseList(core.getMultilineInput('azure-infra-hosts'))

  const configFile = core.getInput('config-file')
  const sudoLockdown = core.getInput('sudo-lockdown') === 'true'
  const debug = core.getInput('debug') === 'true'
  const failOnUnsupported = core.getInput('fail-on-unsupported') === 'true'
  const allowExistingConnections = core.getInput('allow-existing-connections') !== 'false'
  const auditSummary = core.getInput('audit-summary') !== 'false'

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
  ]

  if (auditSummary) {
    args.push(`--audit-log=${AUDIT_LOG}`)
  }

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
  if (apiUrl && !offline) {
    args.push(`--api-url=${apiUrl}`)
    args.push(`--job-key=${github.context.job}`)
    try {
      const idToken = await core.getIDToken('codecargo')
      args.push(`--token=${idToken}`)
    } catch (error) {
      core.warning(`Failed to get OIDC token for policy fetch: ${error}. Falling back to env/file config.`)
      // Remove api-url and job-key so Go binary uses env/file fallback
      const apiUrlIdx = args.indexOf(`--api-url=${apiUrl}`)
      if (apiUrlIdx !== -1) args.splice(apiUrlIdx, 1)
      const jobKeyIdx = args.indexOf(`--job-key=${github.context.job}`)
      if (jobKeyIdx !== -1) args.splice(jobKeyIdx, 1)
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
    ...(githubServiceHosts && { CARGOWALL_GITHUB_SERVICE_HOSTS: githubServiceHosts }),
    ...(azureInfraHosts && { CARGOWALL_AZURE_INFRA_HOSTS: azureInfraHosts }),
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
  // sentinel), use that real PID — a dead real PID is a genuine crash.
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

    cargowallPid = cargowallPid ?? await readPidFile()
    if (cargowallPid !== null && !(await isProcessAlive(cargowallPid))) {
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

  // cargowall writes the pidfile as root. Make it world-readable so unprivileged
  // workflow steps can `cat /tmp/cargowall.pid` (e.g. examples/secure.yml) — this
  // preserves the readability of the action-written pidfile prior to v1.3.0.
  await makePidFileReadable()

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

/** True if `pid` is alive. Uses sudo since cargowall runs as root. */
async function isProcessAlive(pid: number): Promise<boolean> {
  const rc = await exec.exec('sudo', ['kill', '-0', String(pid)], {
    ignoreReturnCode: true,
    silent: true,
  })
  return rc === 0
}

/**
 * Read cargowall's real PID from the pidfile it writes via --pidfile. The file
 * is owned by root, so we read it through sudo. Returns null if absent/unreadable
 * (e.g. cargowall hasn't reached the pidfile write yet).
 */
async function readPidFile(): Promise<number | null> {
  let out = ''
  const rc = await exec.exec('sudo', ['cat', PID_FILE], {
    ignoreReturnCode: true,
    silent: true,
    listeners: { stdout: (data: Buffer) => { out += data.toString() } },
  })
  if (rc !== 0) return null
  const pid = parseInt(out.trim(), 10)
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

/**
 * Best-effort removal of stale ready/pid files left by a prior run in the same
 * (reused) runner, so this launch's readiness/liveness checks only react to files
 * this cargowall writes. The files may be root-owned, so remove via sudo.
 */
async function clearStartupFiles(): Promise<void> {
  await exec.exec('sudo', ['rm', '-f', READY_FILE, PID_FILE], {
    ignoreReturnCode: true,
    silent: true,
  })
}

/**
 * Best-effort: make the root-owned pidfile world-readable so unprivileged
 * workflow steps can read it. Non-fatal if the file is absent or chmod fails.
 */
async function makePidFileReadable(): Promise<void> {
  await exec.exec('sudo', ['chmod', '644', PID_FILE], {
    ignoreReturnCode: true,
    silent: true,
  })
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
 * fail-on-unsupported) or warn, mark unsupported, and restore DNS.
 */
async function handleStartupFailure(
  warnMessage: string,
  throwMessage: string,
  failOnUnsupported: boolean,
): Promise<{ supported: boolean; pid: number | null }> {
  if (failOnUnsupported) {
    core.endGroup()
    throw new Error(throwMessage)
  }
  core.warning(warnMessage)
  core.setOutput('supported', 'false')
  await restoreDns()
  core.endGroup()
  return { supported: false, pid: null }
}

async function restoreDns(): Promise<void> {
  try {
    await fs.access(RESOLV_CONF_BACKUP)
    await exec.exec('sudo', ['cp', RESOLV_CONF_BACKUP, '/etc/resolv.conf'])
  } catch {
    // No backup to restore
  }
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
