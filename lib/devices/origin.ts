/**
 * Where a request to enroll a device, or to attach an installed app, came
 * from (14 October 2026): what an administrator sees before approving it.
 *
 * **Descriptive only, never an access decision.** The address is the one the
 * edge saw (`Fly-Client-IP`), which a VPN or a carrier's NAT can hide; the
 * edge region is the Fly data centre the request entered by, usually the one
 * nearest the phone, so it is a rough "where", not a location; the time zone
 * and language are whatever the device says about itself. Together they let a
 * person notice a request that does not look like the phone they expected.
 *
 * Nothing here calls out to a geolocation service: an address is never sent
 * anywhere by this app.
 */

import type { NextRequest } from "next/server";
import { clientAddress } from "@/lib/rate-limit";

export interface RequestOrigin {
  /** The client address the edge saw; null when there was none (local development). */
  ip: string | null;
  /** The Fly region the request entered by (`Fly-Region`), e.g. `sjc`. */
  edge: string | null;
  /** The browser's user agent, as it sent it. */
  userAgent: string | null;
  /** The device's own time zone (`Intl`), e.g. `America/Los_Angeles`. Reported by the device. */
  timeZone: string | null;
  /** The device's preferred language, e.g. `en-US`. Reported by the device. */
  language: string | null;
}

const clip = (value: string | null | undefined, max: number): string | null => {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, max) : null;
};

/** The origin of this request, with what the page said about its device. */
export function requestOrigin(req: NextRequest, reported: { timeZone?: string; language?: string } = {}): RequestOrigin {
  const ip = clientAddress(req.headers);
  return {
    ip: ip === "local" ? null : clip(ip, 64),
    edge: clip(req.headers.get("fly-region"), 16),
    userAgent: clip(req.headers.get("user-agent"), 400),
    timeZone: clip(reported.timeZone, 64),
    language: clip(reported.language, 35),
  };
}

/** Fly's regions, by code: the city of the data centre, for a person reading the list. */
const FLY_REGIONS: Record<string, string> = {
  ams: "Amsterdam, Netherlands",
  arn: "Stockholm, Sweden",
  atl: "Atlanta, US",
  bog: "Bogotá, Colombia",
  bom: "Mumbai, India",
  bos: "Boston, US",
  cdg: "Paris, France",
  den: "Denver, US",
  dfw: "Dallas, US",
  ewr: "Secaucus NJ, US",
  eze: "Buenos Aires, Argentina",
  fra: "Frankfurt, Germany",
  gdl: "Guadalajara, Mexico",
  gig: "Rio de Janeiro, Brazil",
  gru: "São Paulo, Brazil",
  hkg: "Hong Kong",
  iad: "Ashburn VA, US",
  jnb: "Johannesburg, South Africa",
  lax: "Los Angeles, US",
  lhr: "London, UK",
  mad: "Madrid, Spain",
  mia: "Miami, US",
  nrt: "Tokyo, Japan",
  ord: "Chicago, US",
  otp: "Bucharest, Romania",
  phx: "Phoenix, US",
  qro: "Querétaro, Mexico",
  scl: "Santiago, Chile",
  sea: "Seattle, US",
  sin: "Singapore",
  sjc: "San Jose, US",
  syd: "Sydney, Australia",
  waw: "Warsaw, Poland",
  yul: "Montreal, Canada",
  yyz: "Toronto, Canada",
};

/** "San Jose, US (sjc)" for a known region, the code alone otherwise. */
export function edgeLocation(edge: string | null): string | null {
  if (!edge) return null;
  const place = FLY_REGIONS[edge.toLowerCase()];
  return place ? `${place} (${edge})` : edge;
}
