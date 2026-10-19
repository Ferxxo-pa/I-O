export interface Env {
  DB: D1Database;
  BACKUPS: R2Bucket;
  COMPANY: DurableObjectNamespace;
  ASSETS: Fetcher;
  TOKEN_KEY: string;
  BACKUP_KEY?: string;
  IO_TEST?: string;
  SQUARE_ACCESS_TOKEN?: string;
  SQUARE_WEBHOOK_SIGNATURE_KEY?: string;
  SQUARE_WEBHOOK_NOTIFICATION_URL?: string;
}
