import { isNamedTimeZone } from "@archestra/shared/time-zone";

/**
 * The viewer's IANA time zone, for sending to the API. UTC when the browser
 * reports none, or one the API would refuse.
 */
export function browserTimeZone(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return zone && isNamedTimeZone(zone) ? zone : "UTC";
}
