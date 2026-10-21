export const ACCESS_LOGOUT_PATH = "/cdn-cgi/access/logout?returnTo=/";
export function accessLogoutUrl(origin: string): string {
  return new URL(ACCESS_LOGOUT_PATH, origin).toString();
}
export function logoutFromAccess(location: Pick<Location, "assign"> = window.location): void {
  location.assign(ACCESS_LOGOUT_PATH);
}
