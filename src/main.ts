import * as core from '@actions/core'
import { setup } from './setup'
import { start } from './start'

async function run(): Promise<void> {
  try {
    const ebpfSupported = await setup()

    if (!ebpfSupported) {
      core.saveState('cargowall-skipped', 'true')
      return
    }

    await start()
  } catch (error) {
    if (error instanceof Error) {
      core.setFailed(error.message)
    } else {
      core.setFailed(String(error))
    }
  }
}

run()
