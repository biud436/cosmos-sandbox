// Minimal CDP driver (no puppeteer): load the app, enter planet mode, click
// through several bodies, capture a screenshot of each, and report console
// errors / exceptions. Node 23 has a global WebSocket → raw DevTools Protocol.
const BASE = process.env.APP_URL || 'http://localhost:4317/';
const OUTDIR = process.env.OUTDIR || '/tmp';
// label substrings to click (must appear in a #pp-bodies button)
const BODIES = (process.env.BODIES || 'mars:화성,saturn:토성,sun:태양,jupiter:목성').split(',');

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
  if (msg.method === 'Runtime.exceptionThrown') errors.push('EXCEPTION: ' + (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text));
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') errors.push('ERROR: ' + msg.params.args.map((a) => a.value || a.description || '').join(' '));
  if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error' && !/favicon/.test(msg.params.entry.text)) errors.push('LOG: ' + msg.params.entry.text);
};
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = (expression) => send('Runtime.evaluate', { expression, returnByValue: true });
const { writeFileSync } = await import('node:fs');
const shoot = async (name) => {
  const s = await send('Page.captureScreenshot', { format: 'png' });
  if (s.result?.data) { writeFileSync(`${OUTDIR}/planet-${name}.png`, Buffer.from(s.result.data, 'base64')); console.log('  shot', name); }
};

await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Page.navigate', { url: BASE });
await new Promise((r) => setTimeout(r, 3500));

await evalJs(`document.getElementById('btn-planet').click()`);
await new Promise((r) => setTimeout(r, 5000));
await shoot('earth');

for (const spec of BODIES) {
  const [name, label] = spec.split(':');
  const clicked = await evalJs(`(() => { const b=[...document.querySelectorAll('#pp-bodies button')].find(x=>x.textContent.includes(${JSON.stringify(label)})); if(b){b.click(); return true;} return false; })()`);
  console.log('  click', name, clicked.result?.value);
  await new Promise((r) => setTimeout(r, 4500));
  await shoot(name);
}

console.log('ERRORS:', errors.length ? '\n  ' + errors.slice(0, 25).join('\n  ') : 'none');
ws.close();
process.exit(0);
