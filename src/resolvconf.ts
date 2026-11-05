import * as core from '@actions/core'
import * as exec from '@actions/exec'
import type { Stats } from 'fs'
import { promises as fs } from 'fs'
import { proxyResolvConf } from './dns'

const RESOLV_CONF = '/etc/resolv.conf'
const RESOLV_CONF_BACKUP = '/etc/resolv.conf.cargowall.bak'
// Written in full beside the link it replaces, then renamed over it.
const RESOLV_CONF_NEW = '/etc/resolv.conf.cargowall.new'

/** lstat, or null when there is nothing at path. */
async function lstatOrNull(path: string): Promise<Stats | null> {
  try {
    return await fs.lstat(path)
  } catch {
    return null
  }
}

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
 * Where /etc/resolv.conf is a symlink, the proxy's file replaces the link
 * rather than being written through it. On a runner with systemd-resolved
 * the link points at resolved's stub file, and resolved rewrites that file,
 * back to its own stub, whenever an address or link it counts as relevant
 * changes: an IPv6 address on lo, which cargowall adds for container DNS, a
 * container's veth, a VPN coming up. A repoint written through the link
 * lasts only until the next such change, while a file of our own is never
 * rewritten. It is written beside the link and renamed over it, so the swap
 * is atomic and no lookup finds the file missing or half-written.
 *
 * Anything else is written in place, as a regular file always was. Inside a
 * container or a Kubernetes pod, an ARC runner's included, /etc/resolv.conf
 * is a bind mount, which nothing can be renamed over.
 */
export async function repointResolvConf(): Promise<void> {
  const original = await readResolvConf()
  // Gated on the path, not on what could be read: a link whose target is
  // missing still has to come back as it was.
  const existing = await lstatOrNull(RESOLV_CONF)

  if (existing !== null) {
    try {
      // -P keeps a symlink a symlink, so restoring it hands the runner back
      // to resolved. --remove-destination: a backup a previous job left
      // behind may itself be a link, which a plain copy would write through.
      await exec.exec('sudo', ['cp', '-P', '--remove-destination', RESOLV_CONF, RESOLV_CONF_BACKUP])
      core.info('Backed up /etc/resolv.conf')
    } catch (err) {
      // Not fatal: the firewall still starts, but this run cannot put the
      // resolver back the way it found it.
      core.warning(`Failed to back up /etc/resolv.conf: ${err}`)
    }
  }

  core.info('Configuring DNS to use cargowall proxy...')
  // Fed to `tee` on stdin rather than built into a shell command: the file's
  // own contents are in that text, and nothing from it should reach a shell.
  const input = Buffer.from(proxyResolvConf(original))
  try {
    if (existing?.isSymbolicLink()) {
      // A leftover from a previous job could be a link tee would follow.
      await exec.exec('sudo', ['rm', '-f', RESOLV_CONF_NEW])
      await exec.exec('sudo', ['tee', RESOLV_CONF_NEW], { input, silent: true })
      // Every process on the runner reads it, whatever root's umask made of it.
      await exec.exec('sudo', ['chmod', '0644', RESOLV_CONF_NEW])
      await exec.exec('sudo', ['mv', '-f', '-T', RESOLV_CONF_NEW, RESOLV_CONF])
    } else {
      await exec.exec('sudo', ['tee', RESOLV_CONF], { input, silent: true })
    }
  } catch (err) {
    core.warning(`Failed to overwrite /etc/resolv.conf: ${err}`)
    await exec.exec('sudo', ['rm', '-f', RESOLV_CONF_NEW], { ignoreReturnCode: true, silent: true })
    await restoreDns()
  }
}

/**
 * Put back the resolv.conf repointResolvConf backed up. A link is renamed
 * back into place, which uses the backup up. A file is copied back in place,
 * the way it was replaced.
 */
export async function restoreDns(): Promise<void> {
  // lstat, not access: a link is restored as the link it is, whether or not
  // what it points at exists right now.
  const backup = await lstatOrNull(RESOLV_CONF_BACKUP)
  if (backup === null) {
    // No backup to restore — the common case when there was no resolv.conf.
    return
  }

  try {
    if (backup.isSymbolicLink()) {
      await exec.exec('sudo', ['mv', '-f', '-T', RESOLV_CONF_BACKUP, RESOLV_CONF])
      await restartResolved()
    } else {
      await exec.exec('sudo', ['cp', RESOLV_CONF_BACKUP, RESOLV_CONF])
    }
  } catch (err) {
    // Distinct from having no backup, and worth saying out loud: the resolver
    // is left pointing at a proxy that is not running. Reachable rather than
    // theoretical — sudo lockdown denies the action's own sudo.
    core.warning(`Failed to restore /etc/resolv.conf from ${RESOLV_CONF_BACKUP}: ${err}`)
  }
}

/**
 * While /etc/resolv.conf was a file of ours rather than its link, resolved
 * read it as a foreign one and took its nameserver, the proxy, and its
 * search list as global settings. It keeps them until it starts over.
 * Neither a SIGHUP nor a reload does that: resolved's unit has no reload, and
 * a SIGHUP makes it exit, leaving it to the unit's Restart= to bring it back.
 * try-reload-or-restart restarts it, and only if it is running. Best effort:
 * a runner without systemd-resolved has nothing to restart.
 */
async function restartResolved(): Promise<void> {
  try {
    await exec.exec('sudo', ['systemctl', 'try-reload-or-restart', 'systemd-resolved'], {
      ignoreReturnCode: true,
      silent: true,
    })
  } catch {
    // No systemctl.
  }
}
