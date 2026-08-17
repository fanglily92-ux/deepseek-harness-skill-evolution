import { lstat, mkdir, rm } from 'node:fs/promises'
import { join, relative } from 'node:path'

import { resolveWorkbenchPaths } from './paths.js'

const CANDIDATE_ID = /^EVO-\d{8}-\d{3}$/
const RUN_ID = /^[a-z0-9][a-z0-9-]{0,63}$/

export async function createIsolatedRun({ candidateId, runId, workspace }) {
  if (!CANDIDATE_ID.test(candidateId)) throw new Error('invalid candidate id')
  if (!RUN_ID.test(runId)) throw new Error('invalid run id')
  const paths = resolveWorkbenchPaths(workspace)
  const candidateRoot = join(paths.evaluationRoot, candidateId)
  const root = join(candidateRoot, runId)
  if (relative(paths.evaluationRoot, root).startsWith('..')) throw new Error('evaluation root escaped workspace')
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
