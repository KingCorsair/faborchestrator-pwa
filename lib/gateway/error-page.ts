/**
 * The gateway's own failure, as a page (plan RP5 part 3b).
 *
 * When the gateway cannot deliver one of FabOrchestrator's pages — it is not
 * configured, FabOrchestrator cannot be reached, or it did not answer in time —
 * the phone asked for a document, and a JSON body would show as raw text in
 * the installed app's standalone window. So a document request gets a small
 * page with the same status, the same code and the same sentence, and a way to
 * try again. API requests keep the JSON envelope.
 *
 * Self-contained on purpose: no script, no stylesheet, no image, nothing that
 * needs a working FabOrchestrator or this app's own build to render.
 */

const escapeHtml = (text: string) =>
  text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export function documentErrorResponse(
  status: number,
  code: string,
  sentence: string,
  retryAfterSeconds?: number,
): Response {
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>FabOrchestrator</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f7fb;color:#10153a;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:420px;padding:32px 24px}
h1{font-size:20px;margin:0 0 10px}
p{margin:0 0 18px;line-height:1.5}
a{color:#3b3fd8;font-weight:600;margin-right:18px}
small{color:#667085}
</style>
</head>
<body>
<main>
<h1>This page could not be loaded</h1>
<p>${escapeHtml(sentence)}</p>
<p><a href="">Try again</a><a href="/diagnostics">Diagnostics</a></p>
<small>${escapeHtml(code)}</small>
</main>
</body>
</html>`;
  const headers: Record<string, string> = {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  };
  if (retryAfterSeconds) headers["retry-after"] = String(retryAfterSeconds);
  return new Response(html, { status, headers });
}
