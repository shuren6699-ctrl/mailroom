export interface AccessSyncStatus {
  configured: boolean;
  state: "not_configured" | "synced" | "pending" | "error";
  message: string;
  last_synced_at: string | null;
}
