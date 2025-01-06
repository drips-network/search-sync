export type SyncMetrics = {
  lastSyncTime: Date;
  totalProcessedRecords: number;
};

export type Synchronizer = {
  name: string;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  getMetrics: () => SyncMetrics;
  isHealthy: () => Promise<boolean>;
};
