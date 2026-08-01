export const ACCOUNT_SESSION_COOKIE_NAME_V1 = "__Host-poietra_session";

export function clearAccountSessionCookieV1() {
  return `${ACCOUNT_SESSION_COOKIE_NAME_V1}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
}
