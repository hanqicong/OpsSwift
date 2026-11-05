import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { load } from 'js-yaml'

interface Step { run?: string; uses?: string; with?: Record<string, unknown> }
interface Workflow { on: Record<string, unknown>; permissions: Record<string, string>; jobs: Record<string, { 'runs-on': string; steps: Step[] }> }
const workflow = load(readFileSync('.github/workflows/release.yml', 'utf8')) as Workflow
const steps = workflow.jobs.build.steps
const script = readFileSync('scripts/opsswift-package.py', 'utf8')
const builder = load(readFileSync('electron-builder.yml', 'utf8')) as { mac: { hardenedRuntime: boolean }; publish: unknown }

describe('OpsSwift release qualification', () => {
  it('requires an explicit maintainer run and cannot publish from CI', () => {
    expect(Object.keys(workflow.on)).toEqual(['workflow_dispatch'])
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(steps.some(s => /action-gh-release|gh release/.test((s.uses ?? '') + (s.run ?? '')))).toBe(false)
    expect(builder.publish).toBeNull()
  })
  it('checks source before constructing the candidate from pinned engines', () => {
    const runs = steps.map(s => s.run ?? '').join('\n')
    for (const check of ['npm ci', 'npm run typecheck', 'npm test', 'npm run lint', 'build:sidecar', 'build:addyd', 'build:frpc', 'build:openvpn']) expect(runs).toContain(check)
    expect(runs.indexOf('npm test')).toBeLessThan(runs.indexOf('opsswift-package.py'))
    expect(script).toContain('Engine hash mismatch')
    expect(script).toContain("if len(engines) != 4")
  })
  it('validates the packaged native binding and hardened runtime signature', () => {
    expect(builder.mac.hardenedRuntime).toBe(true)
    expect(script).toContain('verify-local-pty-pack.mjs')
    expect(script).toContain("'--verify','--strict','--deep'")
    expect(script).toContain('com.lyitech.opsswift')
    expect(script).toContain('not Apple notarized')
  })
  it('retains short-lived candidates and offers corresponding OpenVPN source', () => {
    const upload = steps.find(s => s.uses?.includes('upload-artifact'))
    expect(upload?.with?.['retention-days']).toBe(14)
    expect(String(upload?.with?.path)).toContain('source.tar.gz')
    expect(script).toContain('sha256')
  })
})
