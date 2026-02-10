import * as core from '@actions/core'
import * as exec from '@actions/exec'
import { promises as fs } from 'fs'

export interface DnsUpstreamResult {
  primary: string
  all: string[]
  source: string
}

function isValidIPv4(ip: string): boolean {
  const parts = ip.split('.')
  if (parts.length !== 4) return false
  for (const part of parts) {
    if (part === '' || (part.length > 1 && part.startsWith('0'))) return false
    const num = Number(part)
    if (!Number.isInteger(num) || num < 0 || num > 255) return false
  }
  return true
}

function isValidIPv6(ip: string): boolean {
  // Strip brackets if present
  const addr = ip.startsWith('[') && ip.endsWith(']') ? ip.slice(1, -1) : ip
  if (addr === '') return false

  // Handle :: shorthand
  const doubleColonCount = (addr.match(/::/g) || []).length
  if (doubleColonCount > 1) return false

  const groups = addr.split(':')
  const maxGroups = 8

  if (groups.length > maxGroups) return false
  if (doubleColonCount === 0 && groups.length !== 8) return false

  for (const group of groups) {
    if (group === '') continue // part of ::
    if (group.length > 4) return false
    if (!/^[0-9a-fA-F]+$/.test(group)) return false
  }
  return true
}

function isLoopback(ip: string): boolean {
  const normalized = ip.startsWith('[') && ip.endsWith(']') ? ip.slice(1, -1) : ip
  return normalized === '127.0.0.1' || normalized === '127.0.0.53' || normalized === '::1'
}

function ensurePort(address: string): string {
  // Already has port — [IPv6]:port or IPv4:port
  if (/\]:\d+$/.test(address)) return address
  if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(address)) return address

  // Bare IPv6
  if (address.includes(':') && !address.startsWith('[')) {
    return `[${address}]:53`
  }
  // Bracketed IPv6 without port
  if (address.startsWith('[') && address.endsWith(']')) {
    return `${address}:53`
  }
  // Bare IPv4
  return `${address}:53`
}

function validateUpstreamInput(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  // [IPv6]:port
  const ipv6PortMatch = trimmed.match(/^\[(.+)\]:(\d+)$/)
  if (ipv6PortMatch) {
    if (!isValidIPv6(ipv6PortMatch[1])) return null
    const port = Number(ipv6PortMatch[2])
    if (port < 1 || port > 65535) return null
    return trimmed
  }

  // IPv4:port
  const ipv4PortMatch = trimmed.match(/^(\d+\.\d+\.\d+\.\d+):(\d+)$/)
  if (ipv4PortMatch) {
    if (!isValidIPv4(ipv4PortMatch[1])) return null
    const port = Number(ipv4PortMatch[2])
    if (port < 1 || port > 65535) return null
    return trimmed
  }

  // Bare IPv4
  if (isValidIPv4(trimmed)) {
    return `${trimmed}:53`
  }

  // Bare IPv6
  if (isValidIPv6(trimmed)) {
    return `[${trimmed}]:53`
  }

  return null
}

interface ResolvConfResult {
  nameservers: string[]
  hasStubResolver: boolean
}

function parseResolvConf(content: string): ResolvConfResult {
  const nameservers: string[] = []
  let hasStubResolver = false

  for (const line of content.split('\n')) {
    const match = line.match(/^\s*nameserver\s+(\S+)/)
    if (!match) continue

    const ns = match[1]
    if (isLoopback(ns)) {
      hasStubResolver = true
      continue
    }

    if (isValidIPv4(ns) || isValidIPv6(ns)) {
      nameservers.push(ns)
    } else {
      core.warning(`Ignoring invalid nameserver entry in resolv.conf: ${ns}`)
    }
  }

  return { nameservers, hasStubResolver }
}

async function tryResolvConf(filePath: string, label: string): Promise<DnsUpstreamResult | null> {
  try {
    const content = await fs.readFile(filePath, 'utf8')
    const { nameservers, hasStubResolver } = parseResolvConf(content)

    if (nameservers.length > 0) {
      const primary = ensurePort(nameservers[0])
      const all = nameservers.map(ensurePort)
      if (all.length > 1) {
        core.info(`Found ${all.length} nameservers in ${label}: ${all.join(', ')}`)
      }
      core.info(`Auto-detected DNS upstream from ${label}: ${primary}`)
      return { primary, all, source: label }
    }

    if (hasStubResolver) {
      core.debug(`${label} contains only loopback/stub-resolver addresses`)
    }

    return null
  } catch {
    core.debug(`Could not read ${filePath}`)
    return null
  }
}

async function tryResolvectl(): Promise<DnsUpstreamResult | null> {
  try {
    let output = ''
    const exitCode = await exec.exec('resolvectl', ['status'], {
      ignoreReturnCode: true,
      silent: true,
      listeners: {
        stdout: (data: Buffer) => { output += data.toString() }
      }
    })
    if (exitCode !== 0) return null

    const servers: string[] = []

    for (const line of output.split('\n')) {
      // Match "DNS Servers:" or "Current DNS Server:" lines
      const match = line.match(/(?:DNS Servers|Current DNS Server):\s*(.+)/)
      if (!match) continue

      for (const entry of match[1].trim().split(/\s+/)) {
        const ip = entry.trim()
        if (!ip || isLoopback(ip)) continue
        if (isValidIPv4(ip) || isValidIPv6(ip)) {
          if (!servers.includes(ip)) {
            servers.push(ip)
          }
        }
      }
    }

    if (servers.length > 0) {
      const primary = ensurePort(servers[0])
      const all = servers.map(ensurePort)
      if (all.length > 1) {
        core.info(`Found ${all.length} DNS servers via resolvectl: ${all.join(', ')}`)
      }
      core.info(`Auto-detected DNS upstream from resolvectl: ${primary}`)
      return { primary, all, source: 'resolvectl' }
    }

    return null
  } catch {
    core.debug('resolvectl not available')
    return null
  }
}

export async function detectDnsUpstream(userInput: string): Promise<DnsUpstreamResult> {
  // 1. User-provided input
  if (userInput) {
    const validated = validateUpstreamInput(userInput)
    if (validated) {
      core.info(`Using user-provided DNS upstream: ${validated}`)
      return { primary: validated, all: [validated], source: 'user-input' }
    }
    core.warning(`Invalid dns-upstream input "${userInput}", falling through to auto-detection`)
  }

  // 2. /etc/resolv.conf — skip loopback entries
  const resolvResult = await tryResolvConf('/etc/resolv.conf', '/etc/resolv.conf')
  if (resolvResult) return resolvResult

  // 3. systemd-resolved config (tried whenever /etc/resolv.conf yields only loopback)
  const resolvedResult = await tryResolvConf(
    '/run/systemd/resolve/resolv.conf',
    'systemd-resolved'
  )
  if (resolvedResult) return resolvedResult

  // 4. resolvectl status
  const resolvectlResult = await tryResolvectl()
  if (resolvectlResult) return resolvectlResult

  // 5. Fallback
  const fallback = '8.8.8.8:53'
  core.warning(`No upstream DNS detected, falling back to ${fallback}`)
  return { primary: fallback, all: [fallback], source: 'fallback' }
}
