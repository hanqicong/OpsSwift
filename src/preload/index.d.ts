import type { OpsSwiftApi } from './index'

declare global {
  interface Window {
    opsmaxx: OpsSwiftApi
  }
}

export {}
