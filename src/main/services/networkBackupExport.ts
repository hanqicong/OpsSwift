import { app, dialog, safeStorage } from 'electron'
import { constants, openSync, closeSync, readFileSync, writeFileSync, lstatSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { configHash } from './networkCli'

/** Human-only native dialogs. MCP has no filename or decrypt primitive for these backups. */
export async function exportNetworkBackup(): Promise<{ ok: boolean; cancelled?: boolean; error?: string }> {
  try {
    const root = resolve(app.getPath('userData'), 'network-backups')
    const chosen = await dialog.showOpenDialog({ title: 'Export protected network backup', defaultPath: root, properties: ['openFile'], filters: [{ name: 'Network backup', extensions: ['json'] }] })
    if (chosen.canceled || chosen.filePaths.length !== 1) return { ok: false, cancelled: true }
    const source = resolve(chosen.filePaths[0])
    if (dirname(source) !== root || !/^[a-f0-9-]{36}\.json$/.test(basename(source)) || lstatSync(root).isSymbolicLink() || lstatSync(source).isSymbolicLink() || lstatSync(source).size > 8 * 1024 * 1024) throw new Error('invalid backup')
    const fd = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW)
    let raw: string
    try { raw = readFileSync(fd, 'utf8') } finally { closeSync(fd) }
    const envelope = JSON.parse(raw) as { version?: number; sha256?: string; ciphertext?: string }
    if (envelope.version !== 1 || !envelope.ciphertext || !/^[a-f0-9]{64}$/.test(envelope.sha256 ?? '') || !safeStorage.isEncryptionAvailable()) throw new Error('invalid backup')
    const plaintext = safeStorage.decryptString(Buffer.from(envelope.ciphertext, 'base64'))
    if (configHash(plaintext) !== envelope.sha256) throw new Error('backup integrity failed')
    const dest = await dialog.showSaveDialog({ title: 'Export device configuration (contains sensitive data)', defaultPath: `network-backup-${basename(source, '.json')}.cfg`, filters: [{ name: 'Device configuration', extensions: ['cfg'] }] })
    if (dest.canceled || !dest.filePath) return { ok: false, cancelled: true }
    const out = openSync(dest.filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    try { writeFileSync(out, plaintext, 'utf8') } finally { closeSync(out) }
    return { ok: true }
  } catch { return { ok: false, error: 'Backup export failed. Select a valid backup in this application’s network-backups directory and a new destination filename.' } }
}
