import * as core from '@actions/core'
import * as exec from '@actions/exec'
import { promises as fs } from 'fs'
import { proxyResolvConf } from './dns'

const RESOLV_CONF = '/etc/resolv.conf'
const RESOLV_CONF_BACKUP = '/etc/resolv.conf.cargowall.bak'
// Written in full beside the file it replaces, then renamed over it.
const RESOLV_CONF_NEW = '/etc/resolv.conf.cargowall.new'

/**
 * The runner's resolv.conf, or null when there is none.
 *
 * A read the runner user cannot do is not the same as a missing file, and
 * conflating them would silently cost the search list. `sudo cat` tells them
 * apart — the repoint needs root to write anyway, so borrowing it to read
 * costs nothing.
 */
async function readResolvConf(): Promise<string | null> {
  try {
    return await fs.readFile(RESOLV_CONF, 'utf8')
  } catch {
    let contents = ''
    const code = await exec.exec('sudo', ['cat', RESOLV_CONF], {
      ignoreReturnCode: true,
      silent: true,
      listeners: { stdout: (data: Buffer) => { contents += data.toString() } },
    })
    return code === 0 ? contents : null
  }
}

/**
 * Point the runner's resolver at cargowall's proxy, backing up what was there
 * so restoreDns can put it back after a failed startup. The post step
 * deliberately does not — see cleanup.ts.
 *
 * The proxy's resolv.conf replaces /etc/resolv.conf rather than being written
 * through it. On a runner with systemd-resolved, /etc/resolv.conf is a symlink
 * to resolved's stub file, and resolved rewrites that file, back to its own
 * stub, whenever an address or link it counts as relevant changes: an IPv6
 * address on lo, which cargowall adds for container DNS, a docker network
 * created with IPv6, a VPN coming up. A repoint written through the symlink
 * lasts only until the next such change. A regular file of our own is never
 * rewritten. The rename is atomic, so no lookup ever finds the file missing
 * or half-written.
 *
 * The backup keeps a symlink as a symlink (`cp -P`), so restoring it hands
 * the runner back to resolved rather than freezing resolved's stub as it was.
 */
export async function repointResolvConf(): Promise<void> {
  const original = await readResolvConf()

  if (original !== null) {
    try {
      // --remove-destination: a backup a previous job left behind may itself
      // be a symlink, which a plain copy would write through.
      await exec.exec('sudo', ['cp', '-P', '--remove-destination', RESOLV_CONF, RESOLV_CONF_BACKUP])
      core.info('Backed up /etc/resolv.conf')
    } catch (err) {
      // Not fatal: the firewall still starts, but this run cannot put the
      // resolver back the way it found it.
      core.warning(`Failed to back up /etc/resolv.conf: ${err}`)
    }
  }

  core.info('Configuring DNS to use cargowall proxy...')
  try {
    // Fed to `tee` on stdin rather than built into a shell command: the file's
    // own contents are in that text, and nothing from it should reach a shell.
    await exec.exec('sudo', ['tee', RESOLV_CONF_NEW], {
      input: Buffer.from(proxyResolvConf(original)),
      silent: true,
    })
    // Every process on the runner reads it, whatever root's umask made of it.
    await exec.exec('sudo', ['chmod', '0644', RESOLV_CONF_NEW])
    await exec.exec('sudo', ['mv', '-f', '-T', RESOLV_CONF_NEW, RESOLV_CONF])
  } catch (err) {
    core.warning(`Failed to overwrite /etc/resolv.conf: ${err}`)
    await exec.exec('sudo', ['rm', '-f', RESOLV_CONF_NEW], { ignoreReturnCode: true, silent: true })
    await restoreDns()
  }
}

/**
 * Put back the resolv.conf repointResolvConf backed up, symlink or file. The
 * backup is renamed into place, so it is used up: a second call finds none.
 */
export async function restoreDns(): Promise<void> {
  try {
    // lstat, not access: a symlink backup is restored as the link it is,
    // whether or not what it points at exists right now.
    await fs.lstat(RESOLV_CONF_BACKUP)
  } catch {
    // No backup to restore — the common case when there was no resolv.conf.
    return
  }

  try {
    await exec.exec('sudo', ['mv', '-f', '-T', RESOLV_CONF_BACKUP, RESOLV_CONF])
  } catch (err) {
    // Distinct from having no backup, and worth saying out loud: the resolver
    // is left pointing at a proxy that is not running. Reachable rather than
    // theoretical — sudo lockdown denies the action's own sudo.
    core.warning(`Failed to restore /etc/resolv.conf from ${RESOLV_CONF_BACKUP}: ${err}`)
  }
}
