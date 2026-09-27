// Pages Functions 同源設定代理：透過 service binding 保留原始 client IP、方法與條件式標頭。
// Pages 專案 → Settings → Functions → Service bindings：SETTINGS_API → ffxiv-tw-tools-settings-api。
// 綁定缺席時明確回 503；不得用 fetch(workers.dev) 降級（會把所有使用者擠進同一個 IP rate limit）。
const UPSTREAM = 'https://ffxiv-tw-tools-settings-api.ffxiv-tw-tools.workers.dev';

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  if (!env || !env.SETTINGS_API) {
    console.error('[settings-api proxy] 缺少 SETTINGS_API service binding');
    return new Response(JSON.stringify({ error: 'binding_missing' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  const target = UPSTREAM + url.pathname.replace(/^\/settings-api/, '') + url.search;
  const req = new Request(target, request);
  // 同源請求可能不帶 Origin；上游採精確 Origin 白名單，必須標明本站。
  req.headers.set('Origin', url.origin);

  const t0 = Date.now();
  let res;
  try {
    res = await env.SETTINGS_API.fetch(req);
  } catch (err) {
    console.error('[settings-api proxy] upstream fetch failed:', err && err.message);
    return new Response(JSON.stringify({ error: 'proxy_upstream_failed' }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  const out = new Headers(res.headers);
  out.set('Server-Timing', `upstream;dur=${Date.now() - t0}`);
  out.set('Cache-Control', 'no-store');
  return new Response(res.body, { status: res.status, headers: out });
}

export const __test = { UPSTREAM };
