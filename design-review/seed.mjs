/**
 * Seed the in-memory decision log with a realistic set for design review.
 *
 * Written as a file rather than curl arguments so the notes reach the API as
 * UTF-8 — an em dash typed into a Git Bash command line arrives as U+FFFD and
 * the screenshots then show mojibake that the app did not cause.
 */

const API = "http://localhost:3002";
const token = process.argv[2];
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" };

async function post(order, body) {
  const res = await fetch(`${API}/api/orders/${order}/decision`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const payload = await res.json();
  if (!res.ok) throw new Error(`${order} → ${res.status} ${JSON.stringify(payload)}`);
  console.log(`${payload.decision.id}  ${payload.decision.decision.padEnd(8)}  ${order}`);
  return payload.decision;
}

const first = await post("PO-10382", {
  decision: "APPROVE",
  note: "Feeder cleared and the line is back up — running the rest of the shift.",
  recommendedAction:
    "Hold the order, clear the feeder jam at station 3 on ASM-04, and re-inspect the last 60 units before resuming.",
  analysisSource: "cached",
});

await post("PO-10365", {
  decision: "APPROVE",
  note: "Agreed — release the hold once QA signs off on the sample.",
  recommendedAction:
    "Keep the order on hold until the quality check on the last batch completes, then release.",
  analysisSource: "live",
});

const escalated = await post("PO-10344", {
  decision: "ESCALATE",
  note: "Passing to maintenance — third stoppage on this machine this week.",
  recommendedAction: "Escalate to maintenance for a bearing inspection on ASM-02.",
  analysisSource: "live",
});

// One override, so the review sees the superseded trail and the "Override of"
// marker rather than only the simple case.
await post("PO-10344", {
  decision: "APPROVE",
  note: "Maintenance replaced the bearing and signed it off. Resuming production.",
  supersedesId: escalated.id,
});

await post("PO-10391", {
  decision: "REJECT",
  note: "Not stopping the line for this — the defect rate is inside tolerance for the new tool.",
  recommendedAction: "Stop the order and re-qualify the tool before continuing.",
  analysisSource: "live",
});

console.log(`\nseeded. first decision on PO-10382 is ${first.id}`);
