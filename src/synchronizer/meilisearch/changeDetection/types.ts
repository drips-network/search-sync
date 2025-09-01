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
  chain: string;
  isVisible: boolean;
};

export type Project = {
  id: string;
  url: string;
  name: string;
  ownerAddress: string;
  ownerAccountId: string;
  avatarCid: string;
  emoji: string;
  color: string;
  chain: string;
  ownerName: string;
  repoName: string;
  isVisible: boolean;
  verificationStatus: 'claimed' | 'unclaimed' | 'pending_metadata';
};

export type Changes = {
  dripLists: DripList[];
  projects: Project[];
};

export type OnChangesDetected = (changes: Changes) => Promise<void>;
