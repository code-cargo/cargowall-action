/**
 * This action release's version, bumped in the release PR. The action and the
 * cargowall binary it pins (CARGOWALL_VERSION in setup.ts) are versioned
 * separately, so the setup log prints both. check-action-version.sh fails a
 * release whose tag this doesn't match. Empty until this branch has a release:
 * it's consumed by SHA.
 */
export const ACTION_VERSION = ''

/**
 * The setup log's line naming this action: its version, then the repository
 * and ref the job's `uses:` named. A local `uses: ./` has neither.
 */
export function actionVersionLine(version: string = ACTION_VERSION, env: NodeJS.ProcessEnv = process.env): string {
  const repo = env.GITHUB_ACTION_REPOSITORY ?? ''
  const ref = env.GITHUB_ACTION_REF ?? ''
  const source = repo ? (ref ? `${repo}@${ref}` : repo) : 'local'
  return `cargowall-action: ${version ? `${version} (${source})` : source}`
}
