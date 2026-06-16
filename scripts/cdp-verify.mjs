// Minimal CDP driver (no puppeteer): load the app, enter planet mode, capture
// a screenshot, and report any console errors / exceptions. Node 23 has a
// global WebSocket, so we talk raw Chrome DevTools Protocol.
const BASE = process.env.APP_URL || 'http://localhost:4317/';
const OUT = process.env.OUT || '/tmp/planet-shot.png';

async function findPageTarget() {
  for (let i = 0; i < 20; i++) {
    try {
      const list = await (await fetch('http://localhost:9222/json/list')).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('no CDP page target');
}

const target = await findPageTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const pending = new Map();
const errors = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  if (msg.method === 'Runtime.exceptionThrown') {
    errors.push('EXCEPTION: ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
  }
  if (msg.method === 'Runtime.consoleAPICalled' && (msg.params.type === 'error' || msg.params.type === 'warning')) {
    errors.push(msg.params.type.toUpperCase() + ': ' + msg.params.args.map((a) => a.value || a.description || '').join(' '));
  }
  if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
    errors.push('LOG: ' + msg.params.entry.text);
  }
};
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Page.navigate', { url: BASE });
await new Promise((r) => setTimeout(r, 3500)); // boot + first frames

const boot = await send('Runtime.evaluate', { expression: 'document.querySelectorAll(".gl-error").length, true', returnByValue: true });
// Click the planet mode button
await send('Runtime.evaluate', { expression: `document.getElementById('btn-planet').click()`, returnByValue: true });
await new Promise((r) => setTimeout(r, 5000)); // texture load + render frames

// Probe runtime state from the page
const probe = await send('Runtime.evaluate', {
  expression: `(() => {
    const c = document.querySelector('#viewport canvas');
    const panel = document.getElementById('planet-panel');
    return JSON.stringify({
      canvas: !!c, w: c?.width, h: c?.height,
      panelShown: panel && getComputedStyle(panel).display !== 'none',
      caption: document.getElementById('pp-caption')?.textContent?.slice(0,40),
      btn: document.getElementById('btn-planet')?.textContent,
    });
  })()`, returnByValue: true,
});
console.log('PROBE:', probe.result?.value);

const shot = await send('Page.captureScreenshot', { format: 'png' });
if (shot.result?.data) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));
  console.log('SCREENSHOT:', OUT);
}

console.log('ERRORS:', errors.length ? '\n  ' + errors.slice(0, 25).join('\n  ') : 'none');
ws.close();
process.exit(0);
