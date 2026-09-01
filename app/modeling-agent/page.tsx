import type { Metadata } from "next";
import { AgentChatClient } from "../fabinsight/agent-chat-client";

/**
 * `/modeling-agent` — FabOrchestrator's Master Data Load Agent (the cockpit's
 * name for what the code calls the modeling agent), opened from the PWA.
 *
 * The conversation is forwarded to FO's own `/api/modeling-agent/chat`. Nothing
 * about MES modelling is implemented here.
 *
 * ── What this screen deliberately does not carry ────────────────────────────
 * FO's Modeling Agent page also has **file upload** (`/api/modeling-agent/chat/
 * parse-upload`), **download tiles** for the files it prepares
 * (`/chat/download/[id]`) and a **parent-options** picker
 * (`/chat/parent-options/[targetType]`). This is the conversation only. Those
 * three are file-transfer flows into FO's S3 staging, not chat, and each one
 * needs a decision about where a file lives and who may read it — so they are a
 * separate piece of work rather than something to approximate here.
 *
 * ── The role gate is FO's and is left to FO ─────────────────────────────────
 * `app/api/modeling-agent/chat/route.ts` answers **403** unless the account is
 * an admin or its role carries the `modeling_agent` permission. That message
 * arrives verbatim on the screen (`faborch_unavailable`), because it names the
 * exact permission an administrator has to grant. Pre-checking it here with
 * `/api/modeling-agent/access` would mean two places deciding the same thing,
 * and this app would be the one that could be wrong.
 */

export const metadata: Metadata = {
  title: "Master Data Load Agent — FabOrchestrator",
  description:
    "Prepare MES master-data files with FabOrchestrator's Master Data Load " +
    "Agent. Answers " +
    "come from the FabOrchestrator application and its agent.",
};

export default function Page() {
  return <AgentChatClient agentId="modeling" />;
}
