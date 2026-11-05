import { parseSshCompatibility, type SshCompatibility } from '../../shared/networkDevice'

// Refreshed from the human-owned encrypted settings blob, never from an MCP argument.
// Fresh installations stay strict until a person changes the global setting.
let compatibility: SshCompatibility = 'strict'
export function refreshSshPolicy(value: unknown): void { compatibility = parseSshCompatibility(value) }
export function defaultSshCompatibility(): SshCompatibility { return compatibility }
