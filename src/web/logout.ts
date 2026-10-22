export const ACCESS_LOGOUT_PATH = "/cdn-cgi/access/logout";

export function accessLogoutUrl(origin: string): string {
  const logoutUrl = new URL(ACCESS_LOGOUT_PATH, origin);
  logoutUrl.searchParams.set("returnTo", new URL("/", origin).toString());
  return logoutUrl.toString();
}

export function logoutFromAccess(
  location: Pick<Location, "assign" | "origin"> = window.location,
): void {
  location.assign(accessLogoutUrl(location.origin));
}
