import type { Metadata } from "next";
import { AgentChatClient } from "../fabinsight/agent-chat-client";

/**
 * `/backend-agent` — FabOrchestrator's Back-end Agent, opened from the PWA.
 *
 * The conversation is forwarded to FO's own `/api/backend-agent/chat`, which
 * builds its tools from the authenticated user (`buildUiAgentTools(user.id)`)
 * and streams back the same UI message format the other two use. No dashboard
 * logic, no prompt and no model call exists in this app.
 *
 * ── What this screen deliberately does not carry ────────────────────────────
 * FO's own Back-end Agent page has a session-persisted **"Open dashboard"**
 * button that appears once the agent has built one, and the dashboard itself is
 * served by FO at `/v/[key]`. This is the conversation only: the agent will say
 * it has built the dashboard, and it exists in FabOrchestrator, but this screen
 * does not link to it yet. Rendering somebody else's dashboard inside this app
 * is a second implementation of a screen that already exists over there.
 *
 * ⚠ **Production FabOrchestrator does not serve `/backend-agent` today** — the
 * page is on `main` and the deployed build predates it (verified 2026-08-24:
 * `GET /backend-agent` → Next's own 404). The **API** is what this screen needs,
 * and whether that deployment carries `/api/backend-agent/chat` is the thing to
 * check first if this screen reports that FO could not answer.
 */

export const metadata: Metadata = {
  title: "Back-end Agent — FabOrchestrator",
  description:
    "Describe a dashboard and FabOrchestrator's Back-end Agent builds it. Answers " +
    "come from the FabOrchestrator application and its agent.",
};

export default function Page() {
  return <AgentChatClient agentId="backend" />;
}
