/**
 * This action release's version, bumped in the release PR. The action and the
 * cargowall binary it pins (CARGOWALL_VERSION in setup.ts) are versioned
 * separately, so the setup log prints both. check-action-version.sh fails a
 * release whose tag this doesn't match.
 */
export const ACTION_VERSION = 'v1.3.10'

/** This action's repository: only its own tags name a release exactly. */
const ACTION_REPOSITORY = 'code-cargo/cargowall-action'

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
 * and ref the job's `uses:` named. The action's own path says where this code
 * came from, so it wins when it parses; the runner's report stands in only
 * then, since it can name a wrapper action, or nothing at all (an action
 * nested in a composite, a local `uses: ./`). A ref names a release exactly
 * only in this action's repository: a fork's tags are its own.
 */
export function actionVersionLine(
  version: string = ACTION_VERSION,
  env: NodeJS.ProcessEnv = process.env,
  dir: string = __dirname
): string {
  const repo = env.GITHUB_ACTION_REPOSITORY ?? ''
  const found = sourceFromPath(dir) ?? (repo ? { repo, ref: env.GITHUB_ACTION_REF ?? '' } : null)
  const source = found ? (found.ref ? `${found.repo}@${found.ref}` : found.repo) : 'source not reported by the runner'
  const ref = found?.repo.toLowerCase() === ACTION_REPOSITORY ? found.ref : ''
  return `cargowall-action: ${version ? `${releaseAt(version, ref)} (${source})` : source}`
}
