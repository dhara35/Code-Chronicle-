export interface CommitFileSummary {
  path: string;
}

export interface CommitStats {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

export interface CommitEntry {
  hash: string;
  shortHash: string;
  author: string;
  date: string;
  subject: string;
  files: CommitFileSummary[];
  stats: CommitStats;
}
