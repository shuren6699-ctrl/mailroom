import { QueryClient } from "@tanstack/react-query";

/** A workspace client belongs to exactly one identity and set of mailbox grants. */
export function createWorkspaceQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { refetchInterval: 30_000, staleTime: 10_000 },
    },
  });
}
