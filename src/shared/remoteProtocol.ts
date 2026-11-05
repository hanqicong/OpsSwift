/** Protocol selection is owned by the person editing a saved connection, never by an MCP argument. */
export const REMOTE_TRANSPORTS = ['ssh', 'telnet', 'netconf', 'jsonrpc', 'winrm-ntlm', 'winrm-basic', 'windows-ssh'] as const
export type RemoteTransport = typeof REMOTE_TRANSPORTS[number]
export function remoteTransport(tags?: string[]): RemoteTransport {
  const selected = (tags ?? []).filter((s) => s.startsWith('transport:'))
  if (!selected.length) return 'ssh'
  const value = selected[0].slice(10)
  if (selected.length !== 1 || !REMOTE_TRANSPORTS.includes(value as RemoteTransport)) throw new Error('Ambiguous or unsupported saved transport')
  return value as RemoteTransport
}
export const TRANSPORT_PORTS: Record<RemoteTransport, number> = { ssh: 22, telnet: 23, netconf: 830, jsonrpc: 443, 'winrm-ntlm': 5986, 'winrm-basic': 5986, 'windows-ssh': 22 }
export function powerShellCommand(script: string): string {
  if (!script.trim() || Buffer.byteLength(script, 'utf8') > 24 * 1024 || script.includes('\0')) throw new Error('PowerShell script is empty or exceeds 24 KiB')
  // This command executes on the REMOTE SSH server. No local process is started.
  const wrapped = `$ErrorActionPreference='Stop';[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new();try { & {\n${script}\n}; if (-not $?) { exit 1 }; if ($null -ne $LASTEXITCODE -and $LASTEXITCODE -ne 0) { exit $LASTEXITCODE } } catch { [Console]::Error.WriteLine($_.ToString()); exit 1 }`
  return 'powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ' + Buffer.from(wrapped, 'utf16le').toString('base64')
}
export const WINDOWS_FACTS = "Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,BuildNumber,OSArchitecture,LastBootUpTime,TotalVisibleMemorySize,FreePhysicalMemory | ConvertTo-Json -Compress"
