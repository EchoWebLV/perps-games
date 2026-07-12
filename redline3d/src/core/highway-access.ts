export function highwayAvailable(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}
