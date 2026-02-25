import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as github from '@actions/github'
import { spawn } from 'child_process'
import { promises as fs } from 'fs'
import { closeSync, openSync } from 'fs'
import * as path from 'path'
import { detectDnsUpstream } from './dns'
import { findDiagDir, parseJobPlan } from './diag'

const AUDIT_LOG = '/tmp/cargowall-audit.json'
const CARGOWALL_LOG = '/tmp/cargowall.log'
const READY_FILE = '/tmp/cargowall-ready'
const RESOLV_CONF_BACKUP = '/etc/resolv.conf.cargowall.bak'
const STARTUP_TIMEOUT = 30
const STEP_PLAN_FILE = '/tmp/cargowall-step-plan.json'
const STEP_TIMESTAMPS_FILE = '/tmp/cargowall-step-timestamps.jsonl'

const VALID_MODES = ['enforce', 'audit'] as const
const VALID_ACTIONS = ['allow', 'deny'] as const

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
  const mode = core.getInput('mode') || 'enforce'
  const defaultAction = core.getInput('default-action') || 'deny'

  if (!VALID_MODES.includes(mode as typeof VALID_MODES[number])) {
    core.warning(`Invalid mode "${mode}" — expected "enforce" or "audit". Defaulting to "enforce".`)
  }
  if (!VALID_ACTIONS.includes(defaultAction as typeof VALID_ACTIONS[number])) {
    core.warning(`Invalid default-action "${defaultAction}" — expected "allow" or "deny". Defaulting to "deny".`)
  }
  const allowedHosts = core.getInput('allowed-hosts')
  const allowedCidrs = core.getInput('allowed-cidrs')
  const blockedHosts = core.getInput('blocked-hosts')
  const blockedCidrs = core.getInput('blocked-cidrs')
  const configFile = core.getInput('config-file')
  const sudoLockdown = core.getInput('sudo-lockdown') === 'true'
  const debug = core.getInput('debug') === 'true'
  const failOnUnsupported = core.getInput('fail-on-unsupported') === 'true'
  const allowExistingConnections = core.getInput('allow-existing-connections') !== 'false'
  const auditSummary = core.getInput('audit-summary') !== 'false'

  core.startGroup('Starting CargoWall Firewall')

  // Auto-detect DNS upstream before we overwrite resolv.conf
  const dnsResult = await detectDnsUpstream(core.getInput('dns-upstream'))
  const dnsUpstream = dnsResult.primary

  // Build cargowall arguments
  const args: string[] = ['start', '--github-action', `--dns-upstream=${dnsUpstream}`]

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
    const sudoAllowCommands = core.getInput('sudo-allow-commands')
    if (sudoAllowCommands) {
      args.push(`--sudo-allow-commands=${sudoAllowCommands}`)
    }
  }

  if (allowExistingConnections) {
    args.push('--allow-existing-connections')
  }

  // When api-url is configured, fetch OIDC token and pass API flags so the
  // Go binary can fetch the resolved policy from the CodeCargo SaaS API.
  const apiUrl = core.getInput('api-url')
  if (apiUrl) {
    args.push(`--api-url=${apiUrl}`)
    args.push(`--job-key=${github.context.job}`)
    try {
      const audience = core.getInput('api-audience') || 'codecargo'
      const idToken = await core.getIDToken(audience)
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
  core.info(`  Default action: ${defaultAction}`)
  if (allowedHosts) core.info(`  Allowed hosts: ${allowedHosts}`)
  if (allowedCidrs) core.info(`  Allowed CIDRs: ${allowedCidrs}`)
  if (blockedHosts) core.info(`  Blocked hosts: ${blockedHosts}`)
  if (blockedCidrs) core.info(`  Blocked CIDRs: ${blockedCidrs}`)
  if (configFile) core.info(`  Config file: ${configFile}`)
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

  // Set environment variables for cargowall
  const env = {
    ...process.env,
    CARGOWALL_DEFAULT_ACTION: defaultAction,
    CARGOWALL_ALLOWED_HOSTS: allowedHosts,
    CARGOWALL_ALLOWED_CIDRS: allowedCidrs,
    CARGOWALL_BLOCKED_HOSTS: blockedHosts,
    CARGOWALL_BLOCKED_CIDRS: blockedCidrs,
  }

  const logFd = openSync(CARGOWALL_LOG, 'w')
  const child = spawn('sudo', ['-E', 'cargowall', ...args], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env,
  })
  child.unref()
  closeSync(logFd)

  const pid = child.pid
  if (!pid) {
    throw new Error('Failed to start cargowall process')
  }

  core.info(`CargoWall started with PID: ${pid}`)
  core.setOutput('pid', pid)

  // Wait for cargowall to be ready
  core.info('Waiting for cargowall to initialize...')

  for (let i = 0; i < STARTUP_TIMEOUT; i++) {
    try {
      await fs.access(READY_FILE)
      core.info('CargoWall is ready')
      break
    } catch {
      // Not ready yet
    }

    // Check if process is still running
    const killCheck = await exec.exec('sudo', ['kill', '-0', String(pid)], {
      ignoreReturnCode: true,
      silent: true
    })
    if (killCheck !== 0) {
      core.error('CargoWall process exited unexpectedly')

      await showLastLog()

      if (failOnUnsupported) {
        core.endGroup()
        throw new Error('CargoWall failed to start')
      }

      core.warning('CargoWall failed to start. Network filtering is not active.')
      core.setOutput('supported', 'false')

      // Restore DNS
      await restoreDns()
      core.endGroup()
      return { supported: false, pid: null }
    }

    await sleep(1000)
  }

  // Check if we timed out
  try {
    await fs.access(READY_FILE)
  } catch {
    core.error('Timeout waiting for cargowall to be ready')

    await showLastLog()

    // Kill the process
    await exec.exec('sudo', ['kill', String(pid)], { ignoreReturnCode: true, silent: true })

    if (failOnUnsupported) {
      core.endGroup()
      throw new Error('CargoWall timed out starting up')
    }

    core.warning('CargoWall timed out. Network filtering is not active.')
    core.setOutput('supported', 'false')
    await restoreDns()
    core.endGroup()
    return { supported: false, pid: null }
  }

  core.setOutput('supported', 'true')

  // Save PID for cleanup via state (persists to post step)
  core.saveState('cargowall-pid', String(pid))

  // Also write PID file for compatibility
  await fs.writeFile('/tmp/cargowall.pid', String(pid))

  // --- Sub-second step timestamp collection ---
  try {
    const diagDir = await findDiagDir()
    if (diagDir) {
      const stepPlan = await parseJobPlan(diagDir)
      if (Object.keys(stepPlan).length > 0) {
        await fs.writeFile(STEP_PLAN_FILE, JSON.stringify(stepPlan))
        core.info(`Step plan: ${Object.keys(stepPlan).length} steps mapped`)

        // Spawn watcher as detached node process
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
    }
  } catch (err) {
    core.info(`Sub-second timestamp setup: ${err}`)
  }

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

  return { supported: true, pid }
}

async function restoreDns(): Promise<void> {
  try {
    await fs.access(RESOLV_CONF_BACKUP)
    await exec.exec('sudo', ['cp', RESOLV_CONF_BACKUP, '/etc/resolv.conf'])
  } catch {
    // No backup to restore
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
