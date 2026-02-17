import * as core from '@actions/core'

// The Go `cargowall summary` binary now handles pushing audit results to the API
// as part of summary generation. This function is kept as a no-op for backwards
// compatibility with post.ts which calls it.
export async function postAuditResults(_apiUrl: string): Promise<void> {
  core.info('Audit results are now pushed via the cargowall summary command')
}
