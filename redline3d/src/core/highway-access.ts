export function highwayAvailable(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

export type HighwayEntryDecision = "coming-soon" | "driver-name" | "enter";

export function highwayEntryDecision(hostname: string, driverNameConfirmed: boolean): HighwayEntryDecision {
  if (!highwayAvailable(hostname)) return "coming-soon";
  return driverNameConfirmed ? "enter" : "driver-name";
}
