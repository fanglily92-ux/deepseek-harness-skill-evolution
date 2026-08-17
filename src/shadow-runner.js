import { lstat, mkdir, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'

const CANDIDATE_ID = /^EVO-\d{8}-\d{3}$/
const RUN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/

export async function createIsolatedRun({ candidateId, runId, workspace }) {
  if (!CANDIDATE_ID.test(candidateId)) throw new Error('invalid candidate id')
  if (!RUN_ID.test(runId)) throw new Error('invalid run id')
  if (typeof workspace !== 'string' || !isAbsolute(workspace) || resolve(workspace) === resolve('/')) throw new Error('invalid workspace')
  const evaluationRoot = join(resolve(workspace), 'tmp', 'DeepSeek-Harness自进化', 'evals')
  const candidateRoot = join(evaluationRoot, candidateId)
  const root = join(candidateRoot, runId)
  if (relative(evaluationRoot, root).startsWith('..')) throw new Error('evaluation root escaped workspace')
  await mkdir(candidateRoot, { recursive: true })
  await mkdir(root, { recursive: false })
  const stableRoot = join(root, 'stable')
  const proposedRoot = join(root, 'candidate')
  await mkdir(stableRoot)
  await mkdir(proposedRoot)

  return Object.freeze({
    root,
    stableRoot,
    candidateRoot: proposedRoot,
    async cleanup() {
      const stat = await lstat(root)
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('isolated run root is not a real directory')
      await rm(root, { recursive: true, force: false })
    },
  })
}
