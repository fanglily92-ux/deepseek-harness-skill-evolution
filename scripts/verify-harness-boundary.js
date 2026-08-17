#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import { assertAuthorityRootOutsideSandboxTemp, canonicalWorkbenchRoots } from '../src/paths.js'

const REQUIRED_VERSION = '0.1.0-rc.6'

function commandPath(command) {
  const result = spawnSync('which', [command], { encoding: 'utf8', shell: false })
  if (result.status !== 0) throw new Error(`${command} is unavailable`)
  return realpathSync(result.stdout.trim())
}

function dshRoot() {
  const bin = commandPath('dsh')
  const root = dirname(dirname(bin))
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  if (manifest.name !== '@deepseek-ai/dsh' || manifest.version !== REQUIRED_VERSION) {
    throw new Error(`expected @deepseek-ai/dsh@${REQUIRED_VERSION}`)
  }
  return root
}

function executeConfined(provider, target, workspace) {
  const script = 'require("node:fs").writeFileSync(process.argv[1], "probe", { flag: "wx" })'
  const wrapped = provider.confine([process.execPath, '-e', script, target], { mode: 'workspace-write', workspaceRoot: workspace })
  if (wrapped.enforcement !== 'full') throw new Error(`sandbox enforcement is ${wrapped.enforcement}`)
  const result = spawnSync(wrapped.argv[0], wrapped.argv.slice(1), { encoding: 'utf8', shell: false, timeout: 10000 })
  return { status: result.status, signal: result.signal, error: result.error?.code ?? null, stderr: String(result.stderr ?? '').trim().slice(0, 300), enforcement: wrapped.enforcement }
}

export async function verifyHarnessBoundary() {
  const root = dshRoot()
  const sandboxEntry = join(root, 'node_modules', '@deepseek-ai', 'dsh-sandbox-local', 'lib', 'index.js')
  const { LocalSandboxProvider } = await import(pathToFileURL(sandboxEntry).href)
  const cwd = realpathSync(process.cwd())
  const tempRoot = mkdtempSync(join(cwd, '.dsh-evolution-boundary-'))
  const writableSystemTemp = mkdtempSync(join(existsSync('/private/tmp') ? '/private/tmp' : '/tmp', 'dsh-evolution-writable-temp-'))
  mkdirSync(join(tempRoot, 'workspace'))
  mkdirSync(join(tempRoot, 'authority'))
  mkdirSync(join(tempRoot, 'real-workspace'))
  mkdirSync(join(tempRoot, 'real-workspace', 'nested-authority'))
  symlinkSync(join(tempRoot, 'real-workspace'), join(tempRoot, 'workspace-alias'))
  const workspace = realpathSync(join(tempRoot, 'workspace'))
  const authority = realpathSync(join(tempRoot, 'authority'))
  try {
    const provider = new LocalSandboxProvider({
      reflect: { provide() {} },
      effect(register) { register(); return () => undefined },
    }, {
      runnerCommand: [], runnerFailureSignatures: [], probeTimeoutMs: 5000,
    })
    const workspaceTarget = join(workspace, 'allowed.txt')
    const authorityTarget = join(authority, 'denied.txt')
    const systemTempTarget = join(writableSystemTemp, 'allowed-by-sandbox.txt')
    const allowed = executeConfined(provider, workspaceTarget, workspace)
    const denied = executeConfined(provider, authorityTarget, workspace)
    const systemTemp = executeConfined(provider, systemTempTarget, workspace)
    let sandboxTempRejectedAsAuthority = false
    try { assertAuthorityRootOutsideSandboxTemp(writableSystemTemp) } catch { sandboxTempRejectedAsAuthority = true }
    let workspaceAliasRejected = false
    try {
      canonicalWorkbenchRoots(join(tempRoot, 'workspace-alias'), join(tempRoot, 'real-workspace', 'nested-authority'))
    } catch { workspaceAliasRejected = true }
    const result = {
      ok: allowed.status === 0 && existsSync(workspaceTarget)
        && denied.status !== 0 && !existsSync(authorityTarget)
        && systemTemp.status === 0 && existsSync(systemTempTarget)
        && sandboxTempRejectedAsAuthority
        && workspaceAliasRejected,
      harnessVersion: REQUIRED_VERSION,
      sandboxPackage: '@deepseek-ai/dsh-sandbox-local',
      enforcement: allowed.enforcement,
      workspaceWrite: allowed.status === 0 && existsSync(workspaceTarget),
      authorityWriteDenied: denied.status !== 0 && !existsSync(authorityTarget),
      sandboxTempWrite: systemTemp.status === 0 && existsSync(systemTempTarget),
      sandboxTempRejectedAsAuthority,
      workspaceAliasRejected,
    }
    if (!result.ok) throw new Error(`authority boundary probe failed: ${JSON.stringify({ allowed, denied })}`)
    return result
  } finally {
    rmSync(resolve(tempRoot), { recursive: true, force: true })
    rmSync(resolve(writableSystemTemp), { recursive: true, force: true })
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(JSON.stringify(await verifyHarnessBoundary(), null, 2))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  }
}
