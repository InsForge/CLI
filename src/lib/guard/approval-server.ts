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

// Approval window. Override with INSFORGE_GUARD_TIMEOUT_MS (e.g. a longer window
// for a human who isn't watching the terminal). Defaults to 120s, fail-closed.
const TIMEOUT_MS = (() => {
  const v = parseInt(process.env.INSFORGE_GUARD_TIMEOUT_MS ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : 120_000;
})();

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
  const color = SEVERITY_COLOR[brief.severity] ?? '#ef4444';
  const sevLabel = brief.severity.charAt(0).toUpperCase() + brief.severity.slice(1);
  const fact = (k: string, v: string) =>
    `<div class="fact"><div class="k">${k}</div><div class="v">${esc(v)}</div></div>`;
  const agentRow = (k: string, v: string) =>
    `<div class="fact"><div class="k">${k}</div><div class="v">${esc(v)}</div></div>`;
  const agentBody = brief.hasAgentBrief
    ? [
        brief.agent.reason ? agentRow('Intent', brief.agent.reason) : '',
        brief.agent.impact ? agentRow('Implications', brief.agent.impact) : '',
        brief.agent.recommendation ? agentRow('Recommends', brief.agent.recommendation) : '',
      ].join('')
    : `<div class="warn">⚠ No explanation was provided for this destructive operation — treat with extra caution.</div>`;

  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>InsForge — approval required</title>
<style>
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=Manrope:wght@600;700;800&display=swap');
  :root { color-scheme: dark; --mint: #6ee7b7; }
  * { box-sizing: border-box; }
  body { font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 15px; line-height: 1.55; margin: 0; min-height: 100vh; padding: 32px 24px;
    color: #e8e8e8; background: #000;
    background-image:
      linear-gradient(rgba(255,255,255,.022) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255,255,255,.022) 1px, transparent 1px),
      radial-gradient(760px 440px at 50% -8%, rgba(110,231,183,.10), transparent 72%);
    background-size: 44px 44px, 44px 44px, 100% 100%;
    display: flex; align-items: flex-start; justify-content: center; }
  .card { width: 100%; max-width: 560px; background: #121212; border: 1px solid #242424;
    border-radius: 16px; overflow: hidden; box-shadow: 0 30px 80px rgba(0,0,0,.65); }
  .bar { height: 3px; background: linear-gradient(90deg, ${color}, ${color}66); }
  .pad { padding: 22px 24px 24px; }
  .top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 20px; }
  .brand { display: flex; align-items: center; gap: 9px; }
  .brand .wm { font-family: Manrope; font-weight: 800; font-size: 16px; letter-spacing: -.01em; color: #fff; }
  .tag { font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase;
    color: ${color}; background: ${color}14; border: 1px solid ${color}40; padding: 4px 10px; border-radius: 999px; }
  h1 { font-family: Manrope; font-size: 23px; font-weight: 700; letter-spacing: -.02em; margin: 0 0 6px; color: #fff; }
  .sub { color: #9a9a9a; font-size: 13.5px; margin: 0 0 16px; }
  .cmd { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px;
    background: #0a0a0a; border: 1px solid #242424; border-radius: 10px; padding: 12px 14px;
    color: #f0f0f0; white-space: pre-wrap; word-break: break-word; }
  .caption { display: flex; align-items: center; gap: 7px; color: var(--mint);
    font-size: 11.5px; font-weight: 500; margin: 18px 0 2px; }
  .caption .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--mint);
    box-shadow: 0 0 8px var(--mint); }
  .facts { margin-top: 8px; }
  .fact { display: grid; grid-template-columns: 116px 1fr; gap: 18px; padding: 12px 0; border-top: 1px solid #1c1c1c; }
  .fact:first-child { border-top: none; }
  .k { color: #888; font-size: 13px; }
  .v { color: #e8e8e8; }
  .callout { margin: 16px 0 4px; padding: 13px 15px; border-radius: 12px;
    background: rgba(110,231,183,.055); border: 1px solid rgba(110,231,183,.2); }
  .callout .h { font-family: Manrope; font-weight: 700; font-size: 12px; letter-spacing: .02em;
    color: var(--mint); margin-bottom: 5px; }
  .callout .t { color: #d2ece2; font-size: 14px; }
  .agent { margin: 16px 0 4px; padding: 6px 15px 12px; border-radius: 12px;
    background: #0d0d0d; border: 1px solid #222; }
  .agent .h { display: flex; align-items: center; gap: 7px; font-family: Manrope; font-weight: 700;
    font-size: 12px; color: #cacaca; padding: 12px 0 2px; }
  .agent .h .dot { width: 6px; height: 6px; border-radius: 50%; background: #8a8a8a; }
  .agent .fact { grid-template-columns: 104px 1fr; padding: 10px 0; }
  .warn { color: #f0b34a; font-size: 13.5px; padding: 10px 0; }
  .flag { color: #f0b34a; font-size: 13.5px; padding: 10px 12px; margin: 8px 0 2px;
    background: rgba(240,179,74,.08); border: 1px solid rgba(240,179,74,.28); border-radius: 9px; }
  .row { display: grid; grid-template-columns: 1fr 1fr; gap: 11px; margin-top: 22px; }
  button { font-family: Manrope; font-size: 14.5px; font-weight: 700; padding: 13px;
    border-radius: 11px; border: 1px solid transparent; cursor: pointer; transition: all .12s; }
  .deny { background: #1c1c1c; color: #ededed; border-color: #383838; }
  .deny:hover { background: #262626; border-color: #4a4a4a; }
  .approve { background: ${color}; color: #fff; border-color: ${color}; }
  .approve:hover { filter: brightness(1.08); }
  .foot { font-size: 11px; color: #6a6a6a; margin: 16px 0 0; line-height: 1.6; }
  .done { text-align: center; padding: 48px 26px; }
  .done .ok { color: var(--mint); }
</style></head>
<body>
  <div class="card" id="card">
    <div class="bar"></div>
    <div class="pad">
      <div class="top">
        <div class="brand">
          <svg width="18" height="20" viewBox="0 0 18 20" aria-hidden="true">
            <g fill="#6ee7b7"><rect x="0" y="8" width="4" height="12" rx="1.6"/>
            <rect x="7" y="2.5" width="4" height="17.5" rx="1.6"/>
            <rect x="14" y="11" width="4" height="9" rx="1.6"/></g>
          </svg>
          <span class="wm">InsForge</span>
        </div>
        <span class="tag">${esc(sevLabel)}</span>
      </div>

      <h1>${esc(brief.title)}</h1>
      <div class="sub">A coding agent wants to run a destructive operation. Approve only if you intend it.</div>
      <div class="cmd">$ ${esc(brief.command)}</div>

      ${brief.tailored ? '<div class="caption"><span class="dot"></span>Measured from your project just now</div>' : ''}
      <div class="facts">
        ${fact('What happens', brief.whatHappens)}
        ${fact('Blast radius', brief.blastRadius)}
        ${fact('Risk', brief.risks.join(' '))}
      </div>

      ${brief.userImpact ? `<div class="callout"><div class="h">Impact on your users</div><div class="t">${esc(brief.userImpact)}</div></div>` : ''}

      <div class="agent">
        <div class="h"><span class="dot"></span>Agent&#39;s reasoning</div>
        ${brief.agentFlag ? `<div class="flag">⚑ The agent flagged this operation as destructive: ${esc(brief.agentFlag)}</div>` : ''}
        ${agentBody}
      </div>

      <div class="row">
        <button class="deny" onclick="decide('deny')">Deny</button>
        <button class="approve" onclick="decide('approve')">Approve &amp; run</button>
      </div>
      <div class="foot">${esc(brief.guidance)} The agent can explain its intent but cannot change this verdict. This window blocks the CLI until you choose.</div>
    </div>
  </div>
<script>
  function decide(d) {
    fetch('/decision?d=' + d, { method: 'POST' }).then(function () {
      document.getElementById('card').innerHTML =
        '<div class="bar"></div><div class="done"><h1 class="' +
        (d === 'approve' ? 'ok' : '') + '">' +
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
