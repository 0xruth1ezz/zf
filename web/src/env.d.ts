import type { DashboardPayload } from './types';

declare global {
  const __BUILD_VERSION__: string;

  interface Window {
    __ZF_INITIAL_DATA__?: DashboardPayload;
  }
}
