import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as io from '@actions/io'
import { HttpClient } from '@actions/http-client'
import { createHash } from 'crypto'
import { createReadStream, createWriteStream, promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'
import { pipeline } from 'stream/promises'
import { setTimeout as sleep } from 'timers/promises'

const INSTALL_DIR = '/usr/local/bin'
const BINARY_NAME = 'cargowall'
const CARGOWALL_VERSION = 'v1.3.6'

// SHA-256 of each published binary, pinned here instead of fetched from
// checksums.txt: a digest served by the same CDN as the binary was never a
// trust boundary, while one that ships in the action source — which callers
// already pin by tag or SHA — cannot be swapped by whoever is serving the
// download. This pin is also the whole provenance story at runtime: the
// Sigstore attestation's subject IS this digest, so byte-equality with the
// pin proves the same artifact the attestation signs. check-digests.yml
// verifies the attestation and the digest match against the published
// release in CI — at pin time and continuously — which is why setup does
// not fetch attestations.sigstore.json or shell out to `gh` per job.
// Bump these with CARGOWALL_VERSION; check-digests.yml fails the build if
// they drift.
const CARGOWALL_DIGESTS = {
  amd64: 'ac511897cb7952bc61c0a8b99d9bf73fd95148dd8062562aa3862d6c72e53865',
  arm64: '08b56f7d25c3bd5f6c65f3bd4932bc587f049c6eb1c1a0bfc7343e8875c158f7'
} as const

type LinuxArch = keyof typeof CARGOWALL_DIGESTS

function linuxArch(): LinuxArch {
  const archRaw = os.arch()
  switch (archRaw) {
    case 'x64':
      return 'amd64'
    case 'arm64':
      return 'arm64'
    default:
      throw new Error(`Unsupported architecture: ${archRaw}`)
  }
}

const http = new HttpClient('cargowall-action')

// Backoff before each retry, so five attempts in total. #79: the old single
// 500 ms retry closed the window in ~650 ms, so one ECONNRESET from the
// release CDN took the whole job down before the firewall ever started. The
// ~10 s tail is sized to observed degradation: on 2026-08-12 a runner VM's
// resets stayed sticky past an 8 s window while sibling VMs were clean, so
// the last wait has to outlive a bad edge path, not a bad packet.
const DOWNLOAD_RETRY_DELAYS_MS = [500, 2000, 5000, 10000]

// Spread the retries of concurrently-starting jobs instead of resending them
// in lockstep: base/2 .. base*1.5.
function withJitter(baseMs: number): number {
  return Math.round(baseMs / 2 + Math.random() * baseMs)
}

// Worth another attempt. Everything else (404 on a tag that isn't published)
// is deterministic, and retrying only burns time. 403 is handled separately —
// see the token escalation below.
function isRetryableStatus(status: number): boolean {
  return status >= 500 || status === 408 || status === 429
}

// What throttling looks like from inside a runner: a load-shed 503, or a 403
// from the anonymous rate limiter. Both are worth one authenticated re-try.
function isThrottleStatus(status: number): boolean {
  return status === 403 || status === 503
}

type AttemptResult = { ok: true } | { ok: false; reason: string; status: number; retryable: boolean }

// Download a release asset from the public GitHub CDN, streaming to disk.
//
// The first attempt is deliberately anonymous: release-asset URLs 302 to a
// pre-signed objects.githubusercontent.com URL that rejects stray auth, and
// staying anonymous keeps us off the per-repo REST budget that
// `skip-actions-api` exists to protect.
//
// #79: that also puts every request on the anonymous per-source-IP budget, and
// hosted-runner egress is some of the hottest shared IP space there is. So on a
// 403/503, or once transport failures look persistent rather than incidental,
// later attempts carry `github-token` to move the github.com leg onto the
// per-repo authenticated budget. @actions/http-client drops the Authorization
// header when a redirect changes hostname, so the pre-signed leg stays
// anonymous either way.
//
// The backoff loop is hand-rolled because allowRetries/maxRetries on
// @actions/http-client only cover retryable status codes on idempotent verbs;
// a socket-level reset never reaches that path.
export async function downloadAsset(url: string, dest: string, token = ''): Promise<void> {
  const asset = url.split('/').pop() || url
  let authenticated = false

  const attempt = async (): Promise<AttemptResult> => {
    try {
      const headers = authenticated ? { authorization: `Bearer ${token}` } : undefined
      const res = await http.get(url, headers)
      const status = res.message.statusCode ?? 0
      if (status < 200 || status >= 300) {
        res.message.resume()
        return {
          ok: false,
          reason: `HTTP ${status}`,
          status,
          retryable: isRetryableStatus(status)
        }
      }
      await pipeline(res.message, createWriteStream(dest))
      return { ok: true }
    } catch (error) {
      // Connect-time failure (ECONNRESET, DNS, socket timeout) or a body that
      // died mid-stream. Both are transient often enough to be worth a retry.
      return {
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
        status: 0,
        retryable: true
      }
    }
  }

  for (let i = 0; ; i++) {
    const result = await attempt()
    if (result.ok) {
      if (i > 0) core.info(`Downloaded ${asset} on attempt ${i + 1}`)
      return
    }

    // Whatever reached disk is a truncated body — never leave it for the
    // checksum step to find.
    await fs.unlink(dest).catch(() => {})

    // Escalate once: immediately on a throttle response, or after two
    // consecutive transport failures. The latter is evidence-driven
    // (2026-08-12): the per-IP throttle surfaces as pre-HTTP resets as often
    // as 503s — one job died on five straight anonymous hang-ups while every
    // authenticated attempt that day succeeded first try. A failure with the
    // token already attached means auth isn't the lever, so let the normal
    // rules decide.
    const escalate = token !== '' && !authenticated &&
      (isThrottleStatus(result.status) || (result.retryable && i >= 1))
    if (escalate) {
      authenticated = true
      core.info(`Download of ${asset} hit ${result.reason} — retrying authenticated`)
    } else if (!result.retryable) {
      throw new Error(`Failed to download ${url}: ${result.reason}`)
    }
    if (i >= DOWNLOAD_RETRY_DELAYS_MS.length) {
      throw new Error(`Failed to download ${url} after ${i + 1} attempts: ${result.reason}`)
    }

    const delay = withJitter(DOWNLOAD_RETRY_DELAYS_MS[i])
    core.info(
      `Download of ${asset} failed (${result.reason}); ` +
      `retrying in ${delay} ms — attempt ${i + 2} of ${DOWNLOAD_RETRY_DELAYS_MS.length + 1}`
    )
    await sleep(delay)
  }
}

export async function sha256File(file: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(file), hash)
  return hash.digest('hex')
}

export async function setup(): Promise<boolean> {
  const failOnUnsupported = core.getInput('fail-on-unsupported') === 'true'
  const binaryPath = core.getInput('binary-path')

  core.startGroup('CargoWall Setup')

  try {
    if (binaryPath) {
      await installFromLocalPath(binaryPath)
    } else {
      await downloadAndInstall()
    }
  } catch (error) {
    core.endGroup()
    throw error
  }

  core.endGroup()

  // Check eBPF support
  core.startGroup('eBPF Capability Check')
  const ebpfSupported = await checkEbpfSupport()
  core.endGroup()

  if (ebpfSupported) {
    core.info('eBPF support verified')
  } else {
    if (failOnUnsupported) {
      throw new Error('eBPF is not supported on this runner and fail-on-unsupported is set')
    } else {
      core.warning('eBPF may not be fully supported on this runner. Firewall functionality may be limited.')
    }
  }

  core.info('CargoWall setup complete')
  return ebpfSupported
}

async function installFromLocalPath(binaryPath: string): Promise<void> {
  core.info(`Using pre-built binary: ${binaryPath}`)

  try {
    await fs.access(binaryPath)
  } catch {
    throw new Error(`Binary not found at ${binaryPath}`)
  }

  await installBinary(binaryPath)
  await verifyInstallation()
}

async function downloadAndInstall(): Promise<void> {
  const arch = linuxArch()
  core.info(`Detected architecture: ${arch}`)

  const platform = os.platform()
  if (platform !== 'linux') {
    throw new Error(`CargoWall only supports Linux (detected: ${platform})`)
  }

  const repo = 'code-cargo/cargowall'
  const releaseBase = `https://github.com/${repo}/releases/download/${CARGOWALL_VERSION}`
  core.info(`CargoWall version: ${CARGOWALL_VERSION}`)

  const binaryAsset = `cargowall-linux-${arch}`
  core.info(`Downloading ${binaryAsset} from ${repo} release ${CARGOWALL_VERSION}`)

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cargowall-'))
  const binaryDest = path.join(tempDir, BINARY_NAME)

  // Only ever used to escalate past a throttle response — see downloadAsset.
  const token = core.getInput('github-token')

  try {
    await downloadAsset(`${releaseBase}/${binaryAsset}`, binaryDest, token)

    core.info('Verifying checksum against pinned digest...')
    const actualDigest = await sha256File(binaryDest)
    if (actualDigest !== CARGOWALL_DIGESTS[arch]) {
      throw new Error(`Checksum verification failed\nExpected: ${CARGOWALL_DIGESTS[arch]}\nActual: ${actualDigest}`)
    }
    core.info('Checksum verified')

    await installBinary(binaryDest)
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }

  await verifyInstallation()
}

async function installBinary(from: string): Promise<void> {
  await exec.exec('chmod', ['+x', from])
  await exec.exec('sudo', ['cp', from, path.join(INSTALL_DIR, BINARY_NAME)])
  core.info(`Installed cargowall to ${INSTALL_DIR}/${BINARY_NAME}`)
}

async function verifyInstallation(): Promise<void> {
  try {
    await io.which(BINARY_NAME, true)
  } catch {
    throw new Error('cargowall binary not found in PATH after installation')
  }
}

async function checkEbpfSupport(): Promise<boolean> {
  try {
    // Check kernel version
    let kernelVersion = ''
    await exec.exec('uname', ['-r'], {
      listeners: {
        stdout: (data: Buffer) => { kernelVersion += data.toString() }
      }
    })
    kernelVersion = kernelVersion.trim()
    const kernelMajor = parseInt(kernelVersion.split('.')[0], 10)
    core.info(`Kernel version: ${kernelVersion}`)

    if (kernelMajor < 5) {
      core.warning(`Kernel ${kernelVersion} may not fully support eBPF TC programs (need 5.x+)`)
      return false
    }

    // Check BPF syscall availability
    const bpftoolResult = await exec.exec('sudo', ['bpftool', 'prog', 'list'], {
      ignoreReturnCode: true,
      silent: true
    })
    if (bpftoolResult !== 0) {
      // bpftool might not be installed, check for BTF support
      try {
        await fs.access('/sys/kernel/btf/vmlinux')
        core.info('BTF support detected')
      } catch {
        // Not a hard failure
      }
    } else {
      core.info('BPF syscall available')
    }

    // Check capabilities
    let capshOutput = ''
    const capshResult = await exec.exec('sudo', ['capsh', '--print'], {
      ignoreReturnCode: true,
      silent: true,
      listeners: {
        stdout: (data: Buffer) => { capshOutput += data.toString() }
      }
    })
    if (capshResult === 0) {
      if (capshOutput.includes('cap_bpf')) {
        core.info('CAP_BPF available')
      }
      if (capshOutput.includes('cap_net_admin')) {
        core.info('CAP_NET_ADMIN available')
      }
    }

    // Try TC qdisc creation
    let defaultIface = ''
    await exec.exec('bash', ['-c', "ip route | grep default | awk '{print $5}' | head -1"], {
      listeners: {
        stdout: (data: Buffer) => { defaultIface += data.toString() }
      },
      silent: true
    })
    defaultIface = defaultIface.trim()

    if (defaultIface) {
      const tcAddResult = await exec.exec('sudo', ['tc', 'qdisc', 'add', 'dev', defaultIface, 'clsact'], {
        ignoreReturnCode: true,
        silent: true
      })
      if (tcAddResult === 0) {
        core.info('TC clsact qdisc creation successful')
        await exec.exec('sudo', ['tc', 'qdisc', 'del', 'dev', defaultIface, 'clsact'], {
          ignoreReturnCode: true,
          silent: true
        })
      } else {
        // Check if it already exists
        let tcShowOutput = ''
        await exec.exec('sudo', ['tc', 'qdisc', 'show', 'dev', defaultIface], {
          listeners: {
            stdout: (data: Buffer) => { tcShowOutput += data.toString() }
          },
          ignoreReturnCode: true,
          silent: true
        })
        if (tcShowOutput.includes('clsact')) {
          core.info('TC clsact qdisc already exists')
        } else {
          core.warning('Could not create TC clsact qdisc')
          return false
        }
      }
    }

    return true
  } catch {
    return false
  }
}
