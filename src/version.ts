/**
 * This action release's version, bumped in the release PR. The action and the
 * cargowall binary it pins (CARGOWALL_VERSION in setup.ts) are versioned
 * separately, so the setup log prints both. check-action-version.sh fails a
 * release whose tag this doesn't match. Empty until this branch has a release:
 * it's consumed by SHA.
 */
export const ACTION_VERSION = ''

/** The repository and ref the job's `uses:` named. */
interface ActionSource {
  repo: string
  ref: string
}

/**
 * Where a downloaded action runs from, `…/_actions/<owner>/<repo>/<ref>/`, read
 * back as its source; null for any other path, a local `uses: ./` among them.
 */
export function sourceFromPath(dir: string): ActionSource | null {
  const m = dir.match(/\/_actions\/([^/]+)\/([^/]+)\/([^/]+)(\/|$)/)
  return m ? { repo: `${m[1]}/${m[2]}`, ref: m[3] } : null
}

/**
 * What the code at ref is, given this branch's ACTION_VERSION, which is set in
 * a release's PR: the release's own tag, or one of its rcs, names itself; its
 * major tag points at it; anything else (a SHA, a branch) is that release or a
 * later commit.
 */
function releaseAt(version: string, ref: string): string {
  if (ref.startsWith(version) && /^(-rc\.\d+)?$/.test(ref.slice(version.length))) return ref
  if (ref === version.split('.')[0]) return version
  return `${version} or a later commit`
}

/**
 * The setup log's line naming this action: its version, then the repository
 * and ref the job's `uses:` named. The runner doesn't always report those (an
 * action nested in a composite, a local `uses: ./`), so the action's own path
 * stands in.
 */
export function actionVersionLine(
  version: string = ACTION_VERSION,
  env: NodeJS.ProcessEnv = process.env,
  dir: string = __dirname
): string {
  const repo = env.GITHUB_ACTION_REPOSITORY ?? ''
  const found = repo ? { repo, ref: env.GITHUB_ACTION_REF ?? '' } : sourceFromPath(dir)
  const source = found ? (found.ref ? `${found.repo}@${found.ref}` : found.repo) : 'source not reported by the runner'
  return `cargowall-action: ${version ? `${releaseAt(version, found?.ref ?? '')} (${source})` : source}`
}
