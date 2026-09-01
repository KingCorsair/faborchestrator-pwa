/**
 * What FabOrchestrator does — the platform's capabilities, for the front door.
 *
 * ── Why this file exists (2026-08-21) ───────────────────────────────────────
 * `/` used to be the Production Order Assistant's front door, which made this
 * demo look like the whole product. It is one workflow inside a platform that
 * has several. The landing page now says so, and this is the list it says it
 * from.
 *
 * ── The rule this file is under ─────────────────────────────────────────────
 * **Nothing here is invented.** Every entry below names a capability that
 * exists in the shipped product, and carries the document or route it was read
 * from in its `source` field. CLAUDE.md's prohibition on a "feature grid" is
 * about *invented content* — metric tiles, "trusted by", statistics resolving
 * to no MES record. A named capability that traces to a customer-safe overview
 * of the real system is not that. A capability nobody can point at would be,
 * and adding one is the way this file goes wrong.
 *
 * The primary source is `docs/08-customer-safe-overview.md` in the FabOrchestrator
 * product repository (`LLM-AT-SCALE/FabOrchestrator_product_code`)
 * — the platform overview written for people outside the engineering team, and
 * therefore already the right altitude and already cleared for an audience.
 * `§2` below is its "Core capabilities" table. The entries it does not
 * cover cite the routes that implement them instead.
 *
 * ── Why they are not links ──────────────────────────────────────────────────
 * **None of them are implemented in this demo**, and the landing page renders
 * them as plain cards with no href, no hover lift and no arrow, under a heading
 * that says which platform they belong to. A card that looked like a door and
 * opened onto nothing would be the same dishonesty as a hard-coded severity,
 * wearing a different costume. `__tests__/platform/capabilities.test.ts` pins
 * the no-href property, because it is the one somebody would break by making
 * these "clickable for the demo".
 */

import {
  CircleDollarSign,
  Database,
  LayoutDashboard,
  ScrollText,
  ShieldCheck,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export interface PlatformCapability {
  /** Stable key. Used as the React key, and as the handle in the test. */
  id: string;
  icon: LucideIcon;
  title: string;
  /** One sentence: what you would do with it. Not a pitch. */
  line: string;
  /** Where this was read from. Kept in the data so a reviewer can check it. */
  source: string;
}

/**
 * The order is deliberate and is roughly the order a user meets them: the thing
 * you *do* with the assistant, the thing it *produces*, then the three ways the
 * platform is *governed*.
 *
 * ── One entry was removed on 2026-08-23, and its removal is the point ───────
 * **`conversational-analysis`** — *"Ask about live operational data in plain
 * language"* — is FabInsight, and FabInsight is now reachable from this app at
 * `/fabinsight`, forwarded to the running FabOrchestrator. It could not stay on
 * a list whose whole contract is *none of these is implemented here*, and it
 * could not become the list's first `href` either, because the no-href test
 * exists to stop exactly that.
 *
 * `__tests__/platform/capabilities.test.ts` said what to do instead, in the
 * failure message it would have printed: *"If one becomes real, move it into
 * the workflow section."* It is on the landing page as AGENT · 01 of the
 * Nucleus, which is where the product itself puts it.
 */
export const PLATFORM_CAPABILITIES: PlatformCapability[] = [
  {
    id: "master-data-loading",
    icon: Database,
    title: "Master-data loading",
    line: "A guided, validated workflow for preparing manufacturing master data and loading it into the factory MES. Validated before commit and applied all-or-nothing.",
    source: "docs/08-customer-safe-overview.md §2, §5, §6 — Master-data workflow",
  },
  {
    id: "generated-screens",
    icon: LayoutDashboard,
    title: "Generated dashboards",
    line: "Describe the screen you need and the agent builds it, bound to live data, published at its own address for the people who need to read it.",
    source: "claudeai_athena — the Back-end Agent at /backend-agent, its output at /v/[key]",
  },
  {
    id: "access-control",
    icon: ShieldCheck,
    title: "Roles and access control",
    line: "Fine-grained control over which users reach which models, tools and features, with per-role daily request and token quotas.",
    source: "docs/08-customer-safe-overview.md §2, §4 — Role-based access, Usage limits",
  },
  {
    id: "usage-and-cost",
    icon: CircleDollarSign,
    title: "Usage and cost tracking",
    line: "Per-user and per-model token and cost accounting, priced from the model catalogue administrators maintain.",
    source: "docs/08-customer-safe-overview.md §2 — Usage & cost tracking; README — model_registry",
  },
  {
    id: "platform-audit",
    icon: ScrollText,
    title: "Platform audit trail",
    line: "Every login, error and AI prompt and response recorded against a traceable identifier, with configurable retention and redaction.",
    source: "docs/08-customer-safe-overview.md §2, §5 — Comprehensive auditing",
  },
];
