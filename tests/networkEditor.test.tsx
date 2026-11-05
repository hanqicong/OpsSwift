// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { stubBridge } from './setup/renderer'
import { AddServerModal } from '../src/renderer/src/components/connections/AddServerModal'
import { useApp } from '../src/renderer/src/store/app'

beforeEach(() => stubBridge({ ssh: { defaultKeys: async () => [] }, secrets: { set: async () => true, get: async () => null, delete: async () => {} } }))
const confirm = (): HTMLButtonElement => [...document.querySelectorAll<HTMLButtonElement>('.modal-footer button')].at(-1)!

describe('network profile and legacy SSH settings in the connection editor', () => {
  it('sets explicit protocol ports, defaults RPC/script writes off and clears opt-in when transport changes', async () => {
    const u = userEvent.setup(); render(<AddServerModal />)
    await u.selectOptions(screen.getByLabelText('Remote management protocol'), 'netconf')
    expect((screen.getByLabelText('Allow custom RPC execution') as HTMLInputElement).checked).toBe(false)
    expect(screen.queryByRole('button', { name: 'Test connection' })).toBeNull()
    await u.click(screen.getByLabelText('Allow custom RPC execution'))
    await u.selectOptions(screen.getByLabelText('Remote management protocol'), 'winrm-ntlm')
    expect((screen.getByLabelText('Tags') as HTMLInputElement).value).not.toContain('rpc:write')
    expect((screen.getByLabelText('Allow remote PowerShell execution') as HTMLInputElement).checked).toBe(false)
    await u.selectOptions(screen.getByLabelText('Remote management protocol'), 'telnet')
    expect(screen.getByRole('note').textContent).toContain('plaintext')
  })
  it('tests an unsaved Telnet connection with the chosen protocol and port', async () => {
    const test = vi.fn().mockResolvedValue({ ok: true })
    stubBridge({ ssh: { defaultKeys: async () => [], test }, secrets: { get: async () => null } })
    const u = userEvent.setup(); render(<AddServerModal />)
    await u.type(screen.getByPlaceholderText('Production API'), 'Telnet fixture')
    await u.type(screen.getByPlaceholderText('10.20.0.10'), '192.0.2.10')
    await u.selectOptions(screen.getByLabelText('Remote management protocol'), 'telnet')
    await u.type(document.querySelector<HTMLInputElement>('input[type="password"]')!, 'synthetic-password')
    await u.click(screen.getByRole('button', { name: 'Test connection' }))
    expect(test).toHaveBeenCalledWith(expect.objectContaining({ remoteTransport: 'telnet', port: 23, sshCompatibility: 'strict' }))
  })
  it('saves a selected network profile and per-connection legacy policy through the existing store', async () => {
    const u = userEvent.setup(); const view = render(<AddServerModal />)
    await u.type(screen.getByPlaceholderText('Production API'), 'Synthetic switch')
    await u.type(screen.getByPlaceholderText('10.20.0.10'), '192.0.2.10')
    await u.click(screen.getByText('SSH Agent'))
    await u.selectOptions(screen.getByLabelText('Network device type'), 'huawei_vrp')
    await u.selectOptions(screen.getByLabelText('SSH algorithm compatibility'), 'huawei-sha1')
    await u.click(screen.getByLabelText('Allow supported network configuration changes'))
    await u.click(confirm())
    const saved = useApp.getState().servers.find((s) => s.name === 'Synthetic switch')!
    expect(saved.tags).toEqual(['network:huawei_vrp', 'ssh-compat:huawei-sha1', 'network:configure'])
    view.unmount(); useApp.setState({ editServerId: saved.id, modal: 'add-server' } as never)
    render(<AddServerModal />)
    expect((screen.getByLabelText('Network device type') as HTMLSelectElement).value).toBe('huawei_vrp')
    expect((screen.getByLabelText('SSH algorithm compatibility') as HTMLSelectElement).value).toBe('huawei-sha1')
    expect((screen.getByLabelText('Allow supported network configuration changes') as HTMLInputElement).checked).toBe(true)
  })
  it('removes write permission when a person changes from a writable profile to a read-only firewall', async () => {
    const u = userEvent.setup(); render(<AddServerModal />)
    await u.selectOptions(screen.getByLabelText('Network device type'), 'huawei_vrp')
    await u.click(screen.getByLabelText('Allow supported network configuration changes'))
    await u.selectOptions(screen.getByLabelText('Network device type'), 'fortinet_fortios')
    expect(screen.queryByLabelText('Allow supported network configuration changes')).toBeNull()
    expect((screen.getByLabelText('Tags') as HTMLInputElement).value).toBe('network:fortinet_fortios')
  })
  it('blocks saving if adding profile settings would exceed the tag capacity', async () => {
    const u = userEvent.setup(); render(<AddServerModal />)
    await u.type(screen.getByLabelText('Tags'), 'a,b,c,d,e,f,g,h')
    await u.selectOptions(screen.getByLabelText('Network device type'), 'huawei_vrp')
    expect(screen.getByRole('alert').textContent).toContain('More than 8 tags')
    expect(confirm().disabled).toBe(true)
  })
  it('exports only through the dedicated user-initiated native dialog action', async () => {
    const exportBackup = vi.fn().mockResolvedValue({ ok: false, cancelled: true })
    stubBridge({ ssh: { defaultKeys: async () => [], exportNetworkBackup: exportBackup }, secrets: { get: async () => null } })
    const u = userEvent.setup(); render(<AddServerModal />)
    expect(exportBackup).not.toHaveBeenCalled()
    await u.click(screen.getByRole('button', { name: 'Export protected configuration backup' }))
    expect(exportBackup).toHaveBeenCalledTimes(1); expect(exportBackup).toHaveBeenCalledWith()
  })
})
