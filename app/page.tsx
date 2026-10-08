import { redirect } from "next/navigation";
import { FO_COCKPIT_PATH } from "@/lib/gateway/destinations";

/**
 * `/` — the front door, and the manifest's `start_url`.
 *
 * `proxy.ts` answers this path before it gets here: a signed-in visitor goes
 * on to FabOrchestrator's cockpit (`/home`), a signed-out one to `/login`. This
 * page is only the fallback for a request that reaches it anyway.
 */
export default function Page() {
  redirect(FO_COCKPIT_PATH);
}
