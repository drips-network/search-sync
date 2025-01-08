/**
 * The strategy interface for detecting changes in the source database.
 */
export type ChangeDetectionStrategy = {
  start(onChangesDetected: OnChangesDetected): Promise<void>;
  stop(): Promise<void>;
};

export type DripList = {
  id: string;
  name: string;
  description: string;
  ownerAddress: string;
  ownerAccountId: string;
};

export type Project = {
  id: string;
  url: string;
  name: string;
  description: string;
  ownerAddress: string;
  ownerAccountId: string;
  avatarCid: string;
  emoji: string;
  color: string;
};

export type Changes = {
  dripLists: DripList[];
  projects: Project[];
};

export type OnChangesDetected = (changes: Changes) => Promise<void>;
