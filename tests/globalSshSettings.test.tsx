// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { stubBridge } from './setup/renderer'
import { useApp } from '../src/renderer/src/store/app'
import { SshSessions } from '../src/renderer/src/components/settings/SshSessions'
import { AddServerModal } from '../src/renderer/src/components/connections/AddServerModal'

afterEach(() => useApp.getState().setSettings({ sshCompatibilityDefault: 'strict' }))
describe('global SSH policy in the human settings UI', () => {
  it('saves the global full policy and shows inheritance with an explicit strict exception in the editor', async () => {
    stubBridge({ ssh: { poolList: async () => [], defaultKeys: async () => [] }, secrets: { get: async () => null } })
    const u = userEvent.setup(); const view = render(<SshSessions />)
    await u.selectOptions(screen.getByLabelText('Global SSH algorithm compatibility'), 'huawei-legacy')
    expect(useApp.getState().settings.sshCompatibilityDefault).toBe('huawei-legacy')
    view.unmount(); render(<AddServerModal />)
    expect(screen.getByRole('option', { name: 'Inherit global (Full legacy algorithm compatibility)' })).toBeDefined()
    expect((screen.getByLabelText('SSH algorithm compatibility') as HTMLSelectElement).value).toBe('inherit')
    await u.selectOptions(screen.getByLabelText('SSH algorithm compatibility'), 'strict')
    expect((screen.getByLabelText('Tags') as HTMLInputElement).value).toContain('ssh-compat:strict')
    await u.selectOptions(screen.getByLabelText('SSH algorithm compatibility'), 'inherit')
    expect((screen.getByLabelText('Tags') as HTMLInputElement).value).not.toContain('ssh-compat:')
  })
})
