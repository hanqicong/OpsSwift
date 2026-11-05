import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync, statSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { app, dialog } from 'electron'
import { exportNetworkBackup } from '../src/main/services/networkBackupExport'
import { configHash } from '../src/main/services/networkCli'

const root = app.getPath('userData')
vi.mock('electron', async () => {
  const original = await vi.importActual<Record<string, unknown>>('electron')
  return { ...original, dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() } }
})
let count = 0
const raw = 'interface GE1/0/1\n description synthetic-fixture\n#'
const backup = '00000000-0000-4000-8000-000000000001.json'
beforeEach(() => {
  const dir = join(root, 'network-backups'); mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, backup), JSON.stringify({ version: 1, sha256: configHash(raw), ciphertext: Buffer.from(raw).toString('base64') }))
  vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: [join(dir, backup)] })
  vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: false, filePath: join(root, `export-${++count}.cfg`) })
})
describe('human-only network backup export', () => {
  it('exports an integrity-checked snapshot owner-only and never returns its contents', async () => {
    expect(await exportNetworkBackup()).toEqual({ ok: true })
    const file = join(root, `export-${count}.cfg`)
    expect(readFileSync(file, 'utf8')).toBe(raw); expect(statSync(file).mode & 0o777).toBe(0o600)
  })
  it('refuses a backup selected from outside the protected artifact directory', async () => {
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: [join(root, backup)] })
    expect((await exportNetworkBackup()).ok).toBe(false)
  })
  it('refuses tampered ciphertext before opening the save dialog', async () => {
    writeFileSync(join(root, 'network-backups', backup), JSON.stringify({ version: 1, sha256: configHash('different'), ciphertext: Buffer.from(raw).toString('base64') }))
    vi.mocked(dialog.showSaveDialog).mockClear(); expect((await exportNetworkBackup()).ok).toBe(false); expect(dialog.showSaveDialog).not.toHaveBeenCalled()
  })
  it('refuses to overwrite an existing destination', async () => {
    const existing = join(root, 'existing.cfg'); writeFileSync(existing, 'keep')
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({ canceled: false, filePath: existing })
    expect((await exportNetworkBackup()).ok).toBe(false); expect(readFileSync(existing, 'utf8')).toBe('keep')
  })
  it('does not follow a selected backup symlink', async () => {
    const target = join(root, 'outside.json'); writeFileSync(target, '{}'); const link = join(root, 'network-backups', '00000000-0000-4000-8000-000000000002.json'); symlinkSync(target, link)
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: false, filePaths: [link] }); expect((await exportNetworkBackup()).ok).toBe(false)
  })
  it('returns cleanly on native-dialog cancellation', async () => {
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: true, filePaths: [] }); expect(await exportNetworkBackup()).toEqual({ ok: false, cancelled: true })
  })
})
