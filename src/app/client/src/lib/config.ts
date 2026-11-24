import { useFetch } from './api';

export interface AppConfig {
  asOfDate: string | null;
  genieEnabled: boolean;
  resetEnabled: boolean;
  retailerName: string | null;
  /** Contract upload is available (setup wrote the extraction spec). */
  contractUpload: boolean;
  /** Campaigns with a sample IO the presenter can download and upload. */
  sampleIoCampaigns: number[];
}

/** Server-side settings from /api/config (demo date, whether Genie is set up, whether reset is allowed). */
export function useAppConfig() {
  return useFetch<AppConfig>('/api/config');
}
