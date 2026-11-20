import { useCallback, useEffect, useState } from 'react'
import type { TrustedRdpCert } from '../../../../main/services/rdpTrust'
import { useT } from '../../lib/i18n'
import { toast } from '../../store/toast'

export function RdpCertificates(): React.JSX.Element {
  const t = useT()
  const [certificates, setCertificates] = useState<TrustedRdpCert[]>([])
  const [busy, setBusy] = useState(true)
  const [failed, setFailed] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    const entries = await window.opsmaxx.rdpTrust.list()
    setCertificates(entries)
  }, [])

  useEffect(() => {
    void load()
      .catch(() => setFailed(true))
      .finally(() => setBusy(false))
  }, [load])

  const refresh = async (): Promise<void> => {
    setBusy(true)
    setFailed(false)
    try {
      await load()
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  const forget = async (id: string): Promise<void> => {
    setBusy(true)
    setFailed(false)
    try {
      await window.opsmaxx.rdpTrust.forget(id)
      await load()
      toast(t('settingsPage.rdpCerts.forgot', { host: id }), 'ok')
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-label={t('settingsPage.rdpCerts.title')} style={{ marginBottom: 18 }}>
      <div className="setting-row">
        <div className="s-info">
          <div className="s-title">{t('settingsPage.rdpCerts.title')}</div>
          <div className="s-desc">{t('settingsPage.rdpCerts.desc')}</div>
        </div>
        <button className="btn sm" disabled={busy} onClick={() => void refresh()}>
          {t('common.refresh')}
        </button>
      </div>
      {failed && <div role="alert">{t('settingsPage.rdpCerts.error')}</div>}
      {busy && <div role="status">{t('common.loading')}</div>}
      {!busy && !failed && certificates.length === 0 && (
        <div className="s-desc">{t('settingsPage.rdpCerts.empty')}</div>
      )}
      {certificates.map((certificate) => (
        <div className="setting-row" key={certificate.id}>
          <div className="s-info">
            <div className="s-title mono">{certificate.id}</div>
            <div className="s-desc mono" style={{ fontSize: 11, overflowWrap: 'anywhere' }}>
              {certificate.fingerprint}
            </div>
          </div>
          <button
            className="btn sm danger"
            disabled={busy}
            aria-label={t('settingsPage.rdpCerts.forget', { host: certificate.id })}
            onClick={() => void forget(certificate.id)}
          >
            {t('settingsPage.knownHosts.forget')}
          </button>
        </div>
      ))}
    </section>
  )
}
