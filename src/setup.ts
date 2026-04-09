import * as core from '@actions/core'
import * as exec from '@actions/exec'
import * as io from '@actions/io'
import { promises as fs } from 'fs'
import * as os from 'os'
import * as path from 'path'

const INSTALL_DIR = '/usr/local/bin'
const BINARY_NAME = 'cargowall'
const CARGOWALL_VERSION = 'v1.1.0'

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

  await exec.exec('chmod', ['+x', binaryPath])
  await exec.exec('sudo', ['cp', binaryPath, path.join(INSTALL_DIR, BINARY_NAME)])
  core.info('Installed cargowall from local path')

  await verifyInstallation()
}

async function downloadAndInstall(): Promise<void> {
  // Detect architecture
  const archRaw = os.arch()
  let arch: string
  switch (archRaw) {
    case 'x64':
      arch = 'amd64'
      break
    case 'arm64':
      arch = 'arm64'
      break
    default:
      throw new Error(`Unsupported architecture: ${archRaw}`)
  }
  core.info(`Detected architecture: ${arch}`)

  // Check OS
  const platform = os.platform()
  if (platform !== 'linux') {
    throw new Error(`CargoWall only supports Linux (detected: ${platform})`)
  }

  const repo = 'code-cargo/cargowall'
  const githubToken = core.getInput('github-token')
  core.info(`CargoWall version: ${CARGOWALL_VERSION}`)

  const binaryAsset = `cargowall-linux-${arch}`
  core.info(`Downloading ${binaryAsset} from ${repo} release ${CARGOWALL_VERSION}`)

  // Download binary and checksums using gh CLI
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cargowall-'))
  const binaryDest = path.join(tempDir, BINARY_NAME)

  try {
    const ghEnv = githubToken ? { ...process.env, GH_TOKEN: githubToken } : undefined
    const dlResult = await exec.exec('gh', [
      'release', 'download', CARGOWALL_VERSION,
      '--repo', repo,
      '--pattern', binaryAsset,
      '--dir', tempDir
    ], { ignoreReturnCode: true, env: ghEnv })
    if (dlResult !== 0) {
      throw new Error('Failed to download cargowall binary')
    }
    // gh downloads with the original asset name, rename to expected path
    await fs.rename(path.join(tempDir, binaryAsset), binaryDest)

    // Download checksum file
    const checksumDest = path.join(tempDir, 'checksums.txt')
    const csResult = await exec.exec('gh', [
      'release', 'download', CARGOWALL_VERSION,
      '--repo', repo,
      '--pattern', 'checksums.txt',
      '--dir', tempDir
    ], { ignoreReturnCode: true, silent: true, env: ghEnv })

    if (csResult === 0) {
      core.info('Verifying checksum...')
      const checksums = await fs.readFile(checksumDest, 'utf8')
      const expectedLine = checksums.split('\n').find(l => l.includes(`cargowall-linux-${arch}`))
      if (expectedLine) {
        const expectedChecksum = expectedLine.trim().split(/\s+/)[0]

        let actualChecksum = ''
        await exec.exec('sha256sum', [binaryDest], {
          listeners: {
            stdout: (data: Buffer) => { actualChecksum += data.toString() }
          }
        })
        actualChecksum = actualChecksum.trim().split(/\s+/)[0]

        if (expectedChecksum !== actualChecksum) {
          throw new Error(`Checksum verification failed\nExpected: ${expectedChecksum}\nActual: ${actualChecksum}`)
        }
        core.info('Checksum verified')
      }
    } else {
      core.warning('Could not download checksums — attestation verification will still be enforced')
    }

    // Verify GitHub artifact attestation
    core.info('Verifying artifact attestation...')
    const attestResult = await exec.exec('gh', [
      'attestation', 'verify', binaryDest,
      '--repo', repo
    ], { ignoreReturnCode: true, env: ghEnv })


    if (attestResult === 0) {
      core.info('Attestation verified: binary provenance confirmed')
    } else {
      throw new Error('Attestation verification failed — binary provenance could not be confirmed')
    }

    // Install binary
    await exec.exec('chmod', ['+x', binaryDest])
    await exec.exec('sudo', ['mv', binaryDest, path.join(INSTALL_DIR, BINARY_NAME)])
    core.info(`Installed cargowall to ${INSTALL_DIR}/${BINARY_NAME}`)
  } finally {
    // Clean up temp dir
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }

  await verifyInstallation()
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
