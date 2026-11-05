/// <reference types="vite/client" />
import type { OpsSwiftApi } from '../../preload/index'

declare global {
  interface Window {
    opsmaxx: OpsSwiftApi
  }
}

export {}
