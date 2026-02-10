import * as core from '@actions/core'
import * as exec from '@actions/exec'
import { promises as fs } from 'fs'

const CARGOWALL_LOG = '/tmp/cargowall.log'

export async function cleanup(): Promise<void> {
  core.startGroup('CargoWall Cleanup')

  // On GitHub Actions, the runner VM is destroyed after the job.
  // No need to kill cargowall, restore DNS, or detach BPF programs.
  // This avoids a race window where DNS restores before BPF detaches,
  // causing spurious "allowed" events during teardown.

  // Show final log output for debugging
  try {
    await fs.access(CARGOWALL_LOG)
    core.info('Final cargowall log:')
    await exec.exec('tail', ['-50', CARGOWALL_LOG], { ignoreReturnCode: true })
  } catch {
    // No log file
  }

  core.endGroup()
}
