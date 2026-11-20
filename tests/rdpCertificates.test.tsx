// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { stubBridge } from './setup/renderer'
import { RdpCertificates } from '../src/renderer/src/components/settings/RdpCertificates'
import { AddServerModal } from '../src/renderer/src/components/connections/AddServerModal'
import { useApp } from '../src/renderer/src/store/app'
import { rdpSecretId } from '../src/shared/rdp'

const entries = [
  { id: 'win-a.example.test:3389', fingerprint: 'SHA256:synthetic-a', addedAt: '2026-11-18' },
  { id: 'win-b.example.test:3389', fingerprint: 'SHA256:synthetic-b', addedAt: '2026-11-18' }
]

describe('editing a saved RDP password', () => {
  it('leaves the editor open on keychain failure and only saves the RDP secret on retry', async () => {
    const set = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    stubBridge({ ssh: { defaultKeys: async () => [] }, secrets: { set } })
    const store = useApp.getState()
    const id = store.addServer({
      name: 'Synthetic desktop', host: 'win.example.test', rdpOnly: true,
      username: 'fixture', rdp: { username: 'fixture', port: 3389, nla: true }
    })
    store.openServerEditor(id)
    const u = userEvent.setup()
    render(<AddServerModal />)
    const password = screen.getByLabelText('RDP password') as HTMLInputElement
    expect(password.value).toBe('')
    await u.type(password, 'synthetic-replacement')
    await u.click(screen.getByRole('button', { name: 'Save Changes' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Could not save the RDP password')
    expect(useApp.getState().editServerId).toBe(id)
    expect(password.value).toBe('synthetic-replacement')
    await u.click(screen.getByRole('button', { name: 'Save Changes' }))
    await waitFor(() => expect(useApp.getState().modal).toBeNull())
    expect(set.mock.calls).toEqual(Array.from({ length: 2 }, () => [
      rdpSecretId(id), JSON.stringify({ password: 'synthetic-replacement' })
    ]))
  })
})

describe('RDP certificates in security settings', () => {
  it('lists saved certificates and forgets only the selected host before refreshing', async () => {
    let saved = [...entries]
    const forget = vi.fn(async (id: string) => {
      saved = saved.filter((entry) => entry.id !== id)
    })
    const sshForget = vi.fn()
    stubBridge({ rdpTrust: { list: async () => saved, forget }, knownHosts: { forget: sshForget } })
    render(<RdpCertificates />)
    const panel = screen.getByRole('region', { name: 'Trusted RDP certificates' })
    expect(await within(panel).findByText(entries[0].fingerprint)).toBeDefined()
    await userEvent.click(within(panel).getByRole('button', {
      name: `Forget the RDP certificate for ${entries[0].id}`
    }))
    await waitFor(() => expect(within(panel).queryByText(entries[0].fingerprint)).toBeNull())
    expect(within(panel).getByText(entries[1].fingerprint)).toBeDefined()
    expect(forget).toHaveBeenCalledExactlyOnceWith(entries[0].id)
    expect(sshForget).not.toHaveBeenCalled()
  })

  it('shows a failure and keeps the record when forgetting is rejected', async () => {
    stubBridge({ rdpTrust: {
      list: async () => entries,
      forget: async () => { throw new Error('synthetic write failure') }
    } })
    render(<RdpCertificates />)
    await screen.findByText(entries[0].fingerprint)
    await userEvent.click(screen.getByRole('button', {
      name: `Forget the RDP certificate for ${entries[0].id}`
    }))
    expect(await screen.findByRole('alert')).toBeDefined()
    expect(screen.getByText(entries[0].fingerprint)).toBeDefined()
  })

  it('allows refreshing after a list failure', async () => {
    const list = vi.fn().mockRejectedValueOnce(new Error('synthetic list failure')).mockResolvedValue([])
    stubBridge({ rdpTrust: { list } })
    render(<RdpCertificates />)
    await screen.findByRole('alert')
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(await screen.findByText('No saved RDP certificates.')).toBeDefined()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
