/**
 * Localhost human-in-the-loop approval surface.
 *
 * Spins up a single-use HTTP server, opens the approver's browser to a card
 * that explains the operation in human-readable terms, and BLOCKS the CLI
 * until a human clicks Approve or Deny (or the timeout elapses).
 *
 * Fail-closed: any error starting the server, and any timeout, resolves to
 * `denied` — the dangerous command never runs unless a human said yes.
 */

import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import open from 'open';
import type { Brief } from './brief.js';

export type ApprovalResult = 'approved' | 'denied' | 'timeout';

const TIMEOUT_MS = 120_000;

const SEVERITY_COLOR: Record<string, string> = {
  safe: '#16a34a',
  high: '#d97706',
  critical: '#dc2626',
};

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string),
  );
}

function renderPage(brief: Brief): string {
  const color = SEVERITY_COLOR[brief.severity] ?? '#dc2626';
  const risks = brief.risks.map((r) => `<li>${esc(r)}</li>`).join('');
  const sec = (label: string, val: string) =>
    `<section><div class="lbl">${label}</div><div>${esc(val)}</div></section>`;
  const agentBlock = brief.hasAgentBrief
    ? [
        brief.agent.reason ? sec('Intent — what &amp; why', brief.agent.reason) : '',
        brief.agent.impact ? sec('Implications', brief.agent.impact) : '',
        brief.agent.recommendation
          ? `<section><div class="lbl">Agent&#39;s recommendation</div><div class="rec">${esc(brief.agent.recommendation)}</div></section>`
          : '',
      ].join('')
    : `<section><div class="warn">⚠️ The agent provided no explanation for this destructive operation. Treat with extra caution.</div></section>`;
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>InsForge — Human approval required</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Manrope:wght@700;800&display=swap');
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 15px; line-height: 1.55; margin: 0; min-height: 100vh; padding: 28px;
    color: #e8e8e8; background: #000;
    background-image: radial-gradient(900px 520px at 50% -12%, rgba(110,231,183,.07), transparent 70%);
    display: flex; align-items: center; justify-content: center; }
  .card { width: 100%; max-width: 600px; background: #141414; border: 1px solid #262626;
    border-radius: 16px; overflow: hidden; box-shadow: 0 24px 70px rgba(0,0,0,.6); }
  .bar { height: 3px; background: ${color}; }
  .pad { padding: 22px 24px 24px; }
  .brand { display: flex; align-items: center; gap: 9px; margin-bottom: 18px; }
  .brand .wm { font-family: Manrope, Inter, sans-serif; font-weight: 800; font-size: 16px;
    letter-spacing: -.01em; color: #fff; }
  .tag { display: inline-block; font-size: 10.5px; font-weight: 700; letter-spacing: .09em;
    text-transform: uppercase; color: ${color}; background: ${color}1a;
    border: 1px solid ${color}55; padding: 4px 9px; border-radius: 999px; }
  h1 { font-family: Manrope, Inter, sans-serif; font-size: 22px; font-weight: 700;
    letter-spacing: -.02em; margin: 13px 0 4px; color: #fff; }
  .sub { color: #999; font-size: 13px; margin-bottom: 18px; }
  .cmd { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px;
    background: #0a0a0a; border: 1px solid #262626; border-radius: 9px; padding: 11px 13px;
    color: #e8e8e8; white-space: pre-wrap; word-break: break-word; }
  section { margin: 13px 0; }
  .lbl { font-size: 10.5px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase;
    color: #777; margin-bottom: 4px; }
  ul { margin: 6px 0 0; padding-left: 18px; }
  li { margin: 3px 0; }
  .rec { background: #0a0a0a; border-left: 3px solid ${color}; border-radius: 7px;
    padding: 10px 13px; }
  .impact { background: rgba(110,231,183,.05); border: 1px solid #2c4f41; border-radius: 9px;
    padding: 11px 13px; color: #d6e8e0; }
  .grp { font-size: 10.5px; font-weight: 700; letter-spacing: .09em; text-transform: uppercase;
    color: #777; margin: 22px 0 8px; padding-top: 16px; border-top: 1px solid #1f1f1f; }
  .grp.if { color: #6ee7b7; }
  .warn { color: #f0b34a; }
  .row { display: flex; gap: 11px; margin-top: 24px; }
  button { flex: 1; font-family: Manrope, Inter, sans-serif; font-size: 14.5px; font-weight: 700;
    padding: 13px; border-radius: 10px; border: 1px solid transparent; cursor: pointer;
    transition: filter .12s, background .12s; }
  .deny { background: #1a1a1a; color: #e8e8e8; border-color: #333; }
  .deny:hover { background: #222; }
  .approve { background: ${color}; color: #fff; }
  .approve:hover { filter: brightness(1.1); }
  .done { text-align: center; padding: 44px 26px; }
  .foot { font-size: 10.5px; color: #6a6a6a; margin-top: 16px; text-align: center; line-height: 1.5; }
</style></head>
<body>
  <div class="card" id="card">
    <div class="bar"></div>
    <div class="pad">
      <div class="brand">
        <svg width="22" height="24" viewBox="0 0 22 24" fill="none" aria-hidden="true">
          <path d="M11 1.2 20 6.3V17.7L11 22.8 2 17.7V6.3Z" stroke="#6ee7b7" stroke-width="1.5" fill="rgba(110,231,183,.08)"/>
          <path d="M7 15.2 11 7.4 15 15.2" stroke="#6ee7b7" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <span class="wm">InsForge</span>
      </div>
      <span class="tag">${esc(brief.severity)} · human approval required</span>
      <h1>${esc(brief.title)}</h1>
      <div class="sub">An automated agent is requesting to run a destructive InsForge operation.</div>
      <div class="cmd">$ ${esc(brief.command)}</div>

      <div class="grp if">${brief.tailored ? 'Verified by InsForge · measured live from your project' : 'Verified by InsForge · hard rules'}</div>
      <section><div class="lbl">What will happen</div><div>${esc(brief.whatHappens)}</div></section>
      <section><div class="lbl">Blast radius</div><div>${esc(brief.blastRadius)}</div></section>
      <section><div class="lbl">Risks</div><ul>${risks}</ul></section>
      ${brief.userImpact ? `<section><div class="lbl">What this means for your users</div><div class="impact">${esc(brief.userImpact)}</div></section>` : ''}
      <section><div class="lbl">InsForge guidance</div><div class="rec">${esc(brief.guidance)}</div></section>

      <div class="grp">From the agent · intent &amp; implications</div>
      ${agentBlock}

      <div class="row">
        <button class="deny" onclick="decide('deny')">Deny</button>
        <button class="approve" onclick="decide('approve')">Approve &amp; run</button>
      </div>
      <div class="foot">Verdict set by InsForge hard rules · the agent can explain but cannot downgrade it · this window blocks the CLI until you choose</div>
    </div>
  </div>
<script>
  function decide(d) {
    fetch('/decision?d=' + d, { method: 'POST' }).then(function () {
      document.getElementById('card').innerHTML =
        '<div class="bar"></div><div class="done"><h1>' +
        (d === 'approve' ? 'Approved — running now.' : 'Denied — nothing ran.') +
        '</h1><div class="sub">You can close this window.</div></div>';
    });
  }
</script>
</body></html>`;
}

/**
 * Present the brief and block until a human decides.
 * Always resolves; defaults to 'denied' / 'timeout' on any failure.
 */
export function requestApproval(brief: Brief): Promise<ApprovalResult> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: ApprovalResult, server?: ReturnType<typeof createServer>) => {
      if (settled) return;
      settled = true;
      try { server?.close(); } catch { /* ignore */ }
      resolve(r);
    };

    const server = createServer((req, res) => {
      const url = req.url ?? '/';
      if (req.method === 'POST' && url.startsWith('/decision')) {
        const approved = url.includes('d=approve');
        res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
        finish(approved ? 'approved' : 'denied', server);
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(renderPage(brief));
    });

    server.on('error', () => finish('denied', server)); // fail-closed

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      const link = `http://127.0.0.1:${port}/`;
      // Always print the link so a human can approve even if no browser opened
      // (headless agents, remote sessions). This is the "works for all agents" path.
      process.stderr.write(`\n  🛑 Human approval required: ${link}\n\n`);
      // INSFORGE_GUARD_OPEN=0 prints the link only (headless servers, no focus steal).
      if (process.env.INSFORGE_GUARD_OPEN !== '0') {
        open(link).catch(() => { /* link already printed above */ });
      }
    });

    setTimeout(() => finish('timeout', server), TIMEOUT_MS);
  });
}
