import vm from 'vm';

const PACKER_INLINE_RX = /eval\(function\(p,a,c,k,e,d\)\{/;

export function extractKwikEvalPayloads(html, maxDepth = 3) {
  const scripts = getInlineEvalScripts(html);
  const queue = scripts.slice();
  const seen = new Set();
  const collected = [];

  let depth = 0;
  while (queue.length && depth < maxDepth) {
    const cur = queue.shift();
    if (!cur || seen.has(cur)) continue;
    seen.add(cur);

    const nested = runWithEvalCapture(cur);
    for (const n of nested) {
      if (!seen.has(n)) {
        queue.push(n);
      }
      collected.push(n);
    }
    depth++;
  }
  return collected;
}

export function extractKwikCandidatesRaw(html) {
  const payloads = extractKwikEvalPayloads(html);
  const out = new Set();
  for (const code of payloads) {
    const assignMatches = code.match(/\b(?:const|var|let)?\s*(?:source|q)\s*=\s*['"][^'"]+\.m3u8[^'"]*['"]/gi) || [];
    assignMatches.forEach(line => {
      const m = line.match(/['"]([^'"]+\.m3u8[^'"]*)['"]/);
      if (m && m[1]) out.add(m[1]);
    });

    // Any .m3u8 URL
    const urlMatches = code.match(/https?:\/\/[^\s"'`]+\.m3u8[^\s"'`]*/gi) || [];
    urlMatches.forEach(u => out.add(u));
  }
  return [...out];
}

function getInlineEvalScripts(html) {
  const out = [];
  const re = /<script\b[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const body = (m[1] || '').trim();
    if (body && PACKER_INLINE_RX.test(body)) {
      out.push(body);
    }
  }
  return out;
}

function runWithEvalCapture(code) {
  const captured = [];
  const sandbox = {
    console: { log: () => {} },
    document: {},
    window: {},
    navigator: { userAgent: 'Mozilla/5.0' },
    atob: (b64) => Buffer.from(b64,'base64').toString('utf8'),
    btoa: (s) => Buffer.from(s,'utf8').toString('base64'),
    eval: (arg) => {
      if (typeof arg === 'string') {
        captured.push(arg);
      }
      return undefined; // do NOT recurse
    },
    setTimeout: () => {},
    clearTimeout: () => {},
    globalThis: {}
  };
  sandbox.globalThis = sandbox;
  try {
    vm.runInNewContext(code, sandbox, { timeout: 1500 });
  } catch {
    // ignore obfuscation errors
  }
  return captured;
}
