const express = require('express');
const puppeteer = require('puppeteer-core');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3001;

/* ── CORS ── */
const ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)
  .concat(['http://localhost:5173', 'http://localhost:4173']);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    const ok = ORIGINS.some(o => origin === o || origin.endsWith('.vercel.app'));
    cb(ok ? null : new Error('CORS'), ok);
  },
}));
app.use(express.json({ limit: '1mb' }));

/* ── Puppeteer launcher ── */
const findChrome = () => {
  const fromEnv = process.env.PUPPETEER_EXECUTABLE_PATH;
  if (fromEnv) return fromEnv;
  const candidates = [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
  ];
  const fs = require('fs');
  for (const p of candidates) {
    try { if (fs.existsSync(p)) return p; } catch (_) {}
  }
  return '/usr/bin/chromium';
};

const launchBrowser = () =>
  puppeteer.launch({
    executablePath: findChrome(),
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-default-apps',
      '--mute-audio',
      '--no-first-run',
      '--window-size=1280,900',
    ],
  });

/* ── Helpers ── */
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Try multiple selectors and return the first visible match
async function findElement(page, selectors, opts = {}) {
  for (const sel of selectors) {
    try {
      const el = await page.waitForSelector(sel, { timeout: 3000, visible: true, ...opts });
      if (el) {
        console.log(`[findElement] found: ${sel}`);
        return { el, sel };
      }
    } catch (_) {}
  }
  return null;
}

// Take a debug screenshot as base64
async function debugShot(page) {
  try {
    return await page.screenshot({ encoding: 'base64', fullPage: false });
  } catch (_) {
    return null;
  }
}

/* ── Session store (in-memory) ── */
const sessions = new Map();

// GC: close sessions older than 8 minutes
setInterval(() => {
  const cutoff = Date.now() - 8 * 60 * 1000;
  for (const [id, s] of sessions) {
    if (s.createdAt < cutoff) {
      s.browser.close().catch(() => {});
      sessions.delete(id);
      console.log(`[gc] session ${id} expired`);
    }
  }
}, 2 * 60 * 1000);

/* ─────────────────────────────────────────
   POST /api/arca/start
   Body: { cuit: "20123456789" }
   → Navigates to ARCA login, enters CUIT, gets to clave+captcha page.
   ← { ok, sessionId, captcha: dataURL } or error
───────────────────────────────────────── */
app.post('/api/arca/start', async (req, res) => {
  const cuitRaw = (req.body.cuit || '').replace(/\D/g, '');
  if (cuitRaw.length !== 11)
    return res.json({ ok: false, error: 'cuit_invalido', msg: 'El CUIT debe tener 11 dígitos.' });

  if (sessions.size >= 12)
    return res.json({ ok: false, error: 'servidor_ocupado', msg: 'Demasiadas sesiones activas, intentá en unos segundos.' });

  let browser;
  try {
    console.log(`[start] CUIT ${cuitRaw.slice(0, 2)}***`);
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // 1. Go to ARCA login
    console.log('[start] navigating to ARCA...');
    await page.goto('https://auth.afip.gob.ar/contribuyente_/login.xhtml', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });

    const url1 = page.url();
    console.log('[start] landed on:', url1);

    // Wait for JS to render
    await sleep(2000);

    // 2. Find CUIT input field with multiple fallback selectors
    // NOTE: ARCA uses type="number" for CUIT, not type="text"
    const cuitResult = await findElement(page, [
      '#F1\\:username',
      'input[id$=":username"]',
      'input[id$="username"]',
      'input[name*="username"]',
      'input[type="number"]',
      'input[autocomplete="username"]',
    ], { timeout: 10000 });

    if (!cuitResult) {
      const shot = await debugShot(page);
      const html = (await page.content().catch(() => '')).slice(0, 2000);
      console.error('[start] CUIT input not found. URL:', page.url(), 'HTML:', html);
      await browser.close();
      return res.json({
        ok: false,
        error: 'error_conexion',
        msg: 'No se encontró el campo de CUIT en ARCA. El sitio puede estar en mantenimiento.',
      });
    }

    // 3. Fill CUIT and click Siguiente via page.evaluate (avoids Puppeteer type issues with number inputs)
    const filled = await page.evaluate((cuit) => {
      // Try multiple ways to find the CUIT input
      const el = document.getElementById('F1:username') ||
                 document.querySelector('input[name="F1:username"]') ||
                 document.querySelector('input[type="number"]') ||
                 document.querySelector('input[name*="username"]');
      if (!el) return { ok: false, msg: 'CUIT input not found in DOM' };

      // Set value
      el.value = cuit;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));

      return { ok: true, id: el.id, name: el.name };
    }, cuitRaw);

    console.log('[start] fill CUIT result:', JSON.stringify(filled));
    if (!filled.ok) {
      await browser.close();
      return res.json({ ok: false, error: 'error_conexion', msg: 'No se pudo completar el CUIT: ' + filled.msg });
    }

    // 4. Click "Siguiente" + wait for navigation (Promise.all to avoid race condition)
    await Promise.all([
      page.evaluate(() => {
        const btn = document.getElementById('F1:btnSiguiente') ||
                    document.querySelector('input[type="submit"]') ||
                    document.querySelector('button[type="submit"]');
        if (btn) btn.click();
      }),
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 25000 }).catch(() => {}),
    ]);

    await sleep(1500);
    console.log('[start] after Siguiente, url:', page.url());

    // 5. Check for CUIT-level error
    const errText = await page.$eval('#F1\\:msg', el => el.textContent.trim()).catch(() => '');
    if (errText && errText.length > 2) {
      await browser.close();
      return res.json({ ok: false, error: 'cuit_no_encontrado', msg: errText });
    }

    // 6. Wait a bit more and check what page we're on
    await sleep(2000);
    const pageUrl = page.url();
    const pageTitle = await page.title().catch(() => '');
    console.log('[start] page after Siguiente - url:', pageUrl, 'title:', pageTitle);

    // Log all inputs on the current page for debugging
    const pageInputs = await page.$$eval('input', els => els.map(el => ({
      id: el.id, name: el.name, type: el.type, visible: el.offsetWidth > 0
    }))).catch(() => []);
    console.log('[start] inputs on page:', JSON.stringify(pageInputs));

    // 7. Check if password field is visible (we're on the clave page)
    const pageState = await page.evaluate(() => {
      const passEl = document.getElementById('F1:password');
      const hasPassword = passEl && passEl.offsetWidth > 0;

      // Look for captcha image
      const img = document.querySelector('img[alt*="aptcha"]') ||
                  document.querySelector('img[alt*="APTCHA"]') ||
                  document.querySelector('img[alt="Captcha"]') ||
                  document.querySelector('img[src*="captcha"]') ||
                  document.querySelector('img[src*="Captcha"]');

      const hasCaptchaImg = !!img;
      const captchaSrc = img ? img.src : null;

      // Check for visible captcha input
      const captchaInput = document.getElementById('F1:captchaSolutionInput') ||
                           document.querySelector('input[id*="captcha"][type="text"]');
      const hasCaptchaInput = !!(captchaInput && captchaInput.offsetWidth > 0);

      return { hasPassword, hasCaptchaImg, hasCaptchaInput, captchaSrc };
    });

    console.log('[start] page state:', JSON.stringify(pageState));

    if (!pageState.hasPassword) {
      await browser.close();
      return res.json({
        ok: false,
        error: 'error_conexion',
        msg: 'No apareció la pantalla de clave fiscal. Verificá que el CUIT esté registrado en ARCA.',
      });
    }

    // 8. Store session
    const sessionId = uuidv4();
    sessions.set(sessionId, { browser, page, createdAt: Date.now() });

    // Case A: NO CAPTCHA — ARCA skips it for some users
    if (!pageState.hasCaptchaImg) {
      console.log(`[start] session ${sessionId} created — NO CAPTCHA flow`);
      return res.json({ ok: true, sessionId, captcha: null, noCaptcha: true });
    }

    // Case B: WITH CAPTCHA — get the image
    let captchaDataUrl = null;
    if (pageState.captchaSrc && pageState.captchaSrc.startsWith('data:')) {
      captchaDataUrl = pageState.captchaSrc; // already embedded as data URL
    } else if (pageState.captchaSrc) {
      // Fetch with session cookies
      captchaDataUrl = await page.evaluate(async (src) => {
        try {
          const resp = await fetch(src, { credentials: 'include' });
          if (!resp.ok) return null;
          const blob = await resp.blob();
          return await new Promise(resolve => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = () => resolve(null);
            reader.readAsDataURL(blob);
          });
        } catch (_) { return null; }
      }, pageState.captchaSrc);
    }

    console.log('[start] captcha captured, size:', captchaDataUrl ? captchaDataUrl.length : 0);
    console.log(`[start] session ${sessionId} created — WITH CAPTCHA flow`);
    res.json({ ok: true, sessionId, captcha: captchaDataUrl, noCaptcha: false });

  } catch (err) {
    if (browser) browser.close().catch(() => {});
    console.error('[start error]', err.message, err.stack?.split('\n').slice(0, 3).join(' | '));
    res.json({ ok: false, error: 'error_conexion', msg: `Error al conectar con ARCA: ${err.message}` });
  }
});

/* ─────────────────────────────────────────
   POST /api/arca/complete
   Body: { sessionId, clave, captchaSolution }
   ← { ok } on success, or error details
───────────────────────────────────────── */
app.post('/api/arca/complete', async (req, res) => {
  const { sessionId, clave, captchaSolution } = req.body;
  if (!sessionId || !clave)
    return res.json({ ok: false, error: 'faltan_campos', msg: 'Faltan campos requeridos (sessionId, clave).' });

  const s = sessions.get(sessionId);
  if (!s)
    return res.json({ ok: false, error: 'sesion_expirada', msg: 'La sesión expiró. Empezá de nuevo.' });

  const { browser, page } = s;

  try {
    // Fill password (and captcha if present) via page.evaluate
    const filled = await page.evaluate((clave, captcha) => {
      const passEl = document.getElementById('F1:password') ||
                     document.querySelector('input[type="password"]') ||
                     document.querySelector('input[name*="password"]');
      if (!passEl) return { ok: false, msg: 'password field not found' };
      passEl.value = clave;
      passEl.dispatchEvent(new Event('input', { bubbles: true }));
      passEl.dispatchEvent(new Event('change', { bubbles: true }));

      // Captcha field is optional — some ARCA users don't get a CAPTCHA
      if (captcha) {
        const captchaEl = document.getElementById('F1:captchaSolutionInput') ||
                          document.querySelector('input[id*="captcha"][type="text"]') ||
                          document.querySelector('input[name*="captcha"]');
        if (captchaEl) {
          captchaEl.value = captcha;
          captchaEl.dispatchEvent(new Event('input', { bubbles: true }));
          captchaEl.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }

      return { ok: true };
    }, clave, captchaSolution ? captchaSolution.trim() : null);

    console.log('[complete] fill result:', JSON.stringify(filled));
    if (!filled.ok) throw new Error(filled.msg);

    // Click Ingresar + wait for navigation — ARCA button id is F1:btnIngresar
    await Promise.all([
      page.evaluate(() => {
        const btn = document.getElementById('F1:btnIngresar') ||
                    document.querySelector('input[value="Ingresar"]') ||
                    document.querySelector('input[type="submit"]') ||
                    document.querySelector('button[type="submit"]');
        if (btn) btn.click();
      }),
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 25000 }).catch(() => {}),
    ]);

    await sleep(1000);

    const url = page.url();
    console.log('[complete] after submit, url:', url);
    const loginSucceeded = !url.includes('login.xhtml');

    if (loginSucceeded) {
      console.log(`[complete] login OK, landing: ${url}`);
      // Keep session alive for comprobantes fetching
      sessions.set(sessionId, { browser, page, createdAt: Date.now(), authenticated: true });
      return res.json({ ok: true, arcaSessionId: sessionId, landingUrl: url });
    }

    // Still on login page → parse error
    const errText = await page.$eval('#F1\\:msg', el => el.textContent.trim()).catch(() => '');
    console.log('[complete] login failed, errText:', errText);
    const isCaptchaErr = /captcha|imagen|código|caracter/i.test(errText);

    if (isCaptchaErr) {
      // Try to refresh captcha via DOM
      await page.evaluate(() => {
        const refreshBtn = document.querySelector('a[id*="refresh"]') ||
                           document.querySelector('a[onclick*="captcha"]') ||
                           document.querySelector('[id*="refresh"]');
        if (refreshBtn) refreshBtn.click();
      }).catch(() => {});
      await sleep(900);

      // Get new captcha via fetch
      const newCaptchaData = await page.evaluate(async () => {
        const img = document.querySelector('img[alt*="aptcha"]') ||
                    document.querySelector('img[src*="captcha"]');
        if (!img) return null;
        try {
          const resp = await fetch(img.src, { credentials: 'include' });
          const blob = await resp.blob();
          return await new Promise(resolve => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = () => resolve(null);
            reader.readAsDataURL(blob);
          });
        } catch (_) { return img.src.startsWith('data:') ? img.src : null; }
      }).catch(() => null);

      return res.json({
        ok: false,
        error: 'captcha_incorrecto',
        msg: 'El código de la imagen no era correcto. Intentá de nuevo.',
        captcha: newCaptchaData,
      });
    }

    // Wrong clave
    sessions.delete(sessionId);
    browser.close().catch(() => {});
    return res.json({
      ok: false,
      error: 'clave_incorrecta',
      msg: errText || 'Clave fiscal incorrecta. Verificá tu contraseña de ARCA.',
    });

  } catch (err) {
    sessions.delete(sessionId);
    browser.close().catch(() => {});
    console.error('[complete error]', err.message);
    res.json({ ok: false, error: 'error_conexion', msg: 'Error al comunicarse con ARCA: ' + err.message });
  }
});

/* ─────────────────────────────────────────
   POST /api/arca/refresh-captcha
   Body: { sessionId }
   ← { ok, captcha: dataURL }
───────────────────────────────────────── */
app.post('/api/arca/refresh-captcha', async (req, res) => {
  const s = sessions.get(req.body.sessionId);
  if (!s) return res.json({ ok: false, error: 'sesion_expirada' });

  const { page } = s;
  try {
    await page.evaluate(() => {
      const btn = document.querySelector('a[id*="refresh"]') ||
                  document.querySelector('a[onclick*="captcha"]');
      if (btn) btn.click();
    }).catch(() => {});
    await sleep(900);

    const dataUrl = await page.evaluate(async () => {
      const img = document.querySelector('img[alt*="aptcha"]') ||
                  document.querySelector('img[src*="captcha"]');
      if (!img) return null;
      try {
        const resp = await fetch(img.src, { credentials: 'include' });
        const blob = await resp.blob();
        return await new Promise(resolve => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result);
          reader.onerror = () => resolve(null);
          reader.readAsDataURL(blob);
        });
      } catch (_) { return img.src.startsWith('data:') ? img.src : null; }
    }).catch(() => null);

    res.json({ ok: !!dataUrl, captcha: dataUrl });
  } catch (err) {
    res.json({ ok: false, error: 'refresh_error' });
  }
});

/* ── Health check ── */
app.get('/health', (_, res) =>
  res.json({ ok: true, sessions: sessions.size, uptime: Math.round(process.uptime()) })
);

/* ── Debug: check Chrome path ── */
app.get('/debug', (_, res) => {
  const fs = require('fs');
  const chromePath = findChrome();
  const exists = fs.existsSync(chromePath);
  const candidates = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'];
  const found = candidates.filter(p => { try { return fs.existsSync(p); } catch (_) { return false; } });
  res.json({ chromePath, exists, found, env: process.env.PUPPETEER_EXECUTABLE_PATH || null });
});

/* ── Debug: test puppeteer can navigate ── */
app.get('/debug/launch', async (_, res) => {
  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.goto('https://example.com', { waitUntil: 'domcontentloaded', timeout: 15000 });
    const title = await page.title();
    await browser.close();
    res.json({ ok: true, title });
  } catch (err) {
    if (browser) browser.close().catch(() => {});
    res.json({ ok: false, error: err.message });
  }
});

/* ── Debug: screenshot ARCA login + list all inputs ── */
app.get('/debug/arca', async (_, res) => {
  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');
    await page.goto('https://auth.afip.gob.ar/contribuyente_/login.xhtml', {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await sleep(2500);
    const shot = await page.screenshot({ encoding: 'base64' });
    const inputs = await page.$$eval('input', els => els.map(el => ({
      id: el.id, name: el.name, type: el.type,
      value: el.value.slice(0, 20),
      visible: el.offsetWidth > 0 && el.offsetHeight > 0,
    })));
    const title = await page.title();
    const url = page.url();
    await browser.close();
    res.json({ ok: true, title, url, inputs, shot });
  } catch (err) {
    if (browser) browser.close().catch(() => {});
    res.json({ ok: false, error: err.message });
  }
});

/* ── Debug: navigate ARCA with CUIT and show step-2 page inputs ── */
app.get('/debug/arca-step2', async (req, res) => {
  const cuitRaw = (req.query.cuit || '20123456789').replace(/\D/g, '');
  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');

    await page.goto('https://auth.afip.gob.ar/contribuyente_/login.xhtml', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(2000);

    // Fill CUIT and click Siguiente
    await page.evaluate((cuit) => {
      const el = document.getElementById('F1:username') || document.querySelector('input[type="number"]');
      if (el) { el.value = cuit; el.dispatchEvent(new Event('change', { bubbles: true })); }
      const btn = document.getElementById('F1:btnSiguiente') || document.querySelector('input[type="submit"]');
      if (btn) btn.click();
    }, cuitRaw);

    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 25000 }).catch(() => {});
    await sleep(3000);

    const url = page.url();
    const title = await page.title();
    const shot = await page.screenshot({ encoding: 'base64' });
    const inputs = await page.$$eval('input', els => els.map(el => ({
      id: el.id, name: el.name, type: el.type, placeholder: el.placeholder,
      visible: el.offsetWidth > 0 && el.offsetHeight > 0,
    })));
    const imgs = await page.$$eval('img', els => els.map(el => ({
      src: el.src.slice(0, 80), alt: el.alt, width: el.naturalWidth, height: el.naturalHeight,
    })));
    const errMsg = await page.$eval('#F1\\:msg', el => el.textContent.trim()).catch(() => '');

    await browser.close();
    res.json({ ok: true, url, title, inputs, imgs, errMsg, shot });
  } catch (err) {
    if (browser) browser.close().catch(() => {});
    res.json({ ok: false, error: err.message });
  }
});

/* ─────────────────────────────────────────
   POST /api/arca/fetch-comprobantes
   Body: { sessionId, periodo: "2026-03" }
   → Navigates to "Mis Comprobantes" → Recibidos for the given month
   ← { ok, comprobantes: [...] }
───────────────────────────────────────── */
app.post('/api/arca/fetch-comprobantes', async (req, res) => {
  const { sessionId, periodo } = req.body; // periodo: "2026-03"
  const s = sessions.get(sessionId);
  if (!s || !s.authenticated)
    return res.json({ ok: false, error: 'sesion_expirada', msg: 'La sesión expiró. Volvé a conectar con ARCA.' });

  const { browser, page } = s;

  // Parse periodo → mes/año
  const [year, month] = (periodo || new Date().toISOString().slice(0, 7)).split('-');

  try {
    console.log(`[comprobantes] fetching for ${year}-${month}`);

    // 1. Navigate to "Mis Comprobantes" in ARCA portal
    // ARCA uses the same auth session across *.afip.gob.ar / *.arca.gob.ar
    await page.goto('https://comprobantes.afip.gob.ar/cgi-bin/cgi_cile?modoAcceso=RangoFechas&opcion=1', {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });
    await sleep(2000);

    const urlAfterNav = page.url();
    console.log(`[comprobantes] after nav to CILE: ${urlAfterNav}`);

    // If redirected to login, session expired
    if (urlAfterNav.includes('login') || urlAfterNav.includes('auth.afip')) {
      sessions.delete(sessionId);
      browser.close().catch(() => {});
      return res.json({ ok: false, error: 'sesion_expirada', msg: 'La sesión de ARCA expiró. Volvé a conectar.' });
    }

    // 2. Take debug screenshot + list all links/inputs to understand the portal
    const title = await page.title().catch(() => '');
    console.log(`[comprobantes] title: ${title}, url: ${urlAfterNav}`);

    // Try to gather page info
    const pageInfo = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a')).map(a => ({
        text: a.textContent.trim().slice(0, 80), href: a.href.slice(0, 150)
      }));
      const inputs = Array.from(document.querySelectorAll('input,select,button')).map(el => ({
        tag: el.tagName, id: el.id, name: el.name, type: el.type || '',
        visible: el.offsetWidth > 0, value: el.value?.slice(0, 50)
      }));
      const tables = Array.from(document.querySelectorAll('table')).map(t => ({
        rows: t.rows.length,
        firstRowText: t.rows[0]?.textContent?.trim().slice(0, 200) || ''
      }));
      const bodyText = document.body?.innerText?.slice(0, 3000) || '';
      return { links: links.slice(0, 40), inputs, tables, bodyText };
    }).catch(() => ({ links: [], inputs: [], tables: [], bodyText: '' }));

    console.log(`[comprobantes] tables: ${JSON.stringify(pageInfo.tables)}`);
    console.log(`[comprobantes] body preview: ${pageInfo.bodyText.slice(0, 500)}`);

    // 3. Try to find and click "Recibidos" tab/link if available
    const clickedRecibidos = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a, button, input[type="submit"], input[type="button"]'));
      const recib = links.find(el => /recib/i.test(el.textContent) || /recib/i.test(el.value || ''));
      if (recib) { recib.click(); return recib.textContent?.trim() || recib.value || 'clicked'; }
      return null;
    }).catch(() => null);

    if (clickedRecibidos) {
      console.log(`[comprobantes] clicked recibidos: ${clickedRecibidos}`);
      await sleep(3000);
      await page.waitForNetworkIdle({ timeout: 10000 }).catch(() => {});
    }

    // 4. Try to set date range for the current month
    const dateSet = await page.evaluate((y, m) => {
      const results = [];
      // Look for date inputs (fechaDesde, fechaHasta, etc.)
      const dateInputs = Array.from(document.querySelectorAll('input')).filter(el =>
        /fecha|date|desde|hasta|inicio|fin/i.test(el.id + el.name)
      );
      for (const inp of dateInputs) {
        const isDesde = /desde|inicio|from|start/i.test(inp.id + inp.name);
        const isHasta = /hasta|fin|end|to/i.test(inp.id + inp.name);
        if (isDesde) {
          inp.value = `01/${m}/${y}`;
          inp.dispatchEvent(new Event('change', { bubbles: true }));
          results.push(`desde: 01/${m}/${y}`);
        } else if (isHasta) {
          const lastDay = new Date(parseInt(y), parseInt(m), 0).getDate();
          inp.value = `${lastDay}/${m}/${y}`;
          inp.dispatchEvent(new Event('change', { bubbles: true }));
          results.push(`hasta: ${lastDay}/${m}/${y}`);
        }
      }
      // Try to find and click search/buscar button
      const btns = Array.from(document.querySelectorAll('input[type="submit"], input[type="button"], button'));
      const searchBtn = btns.find(b => /buscar|consultar|search|filtrar/i.test(b.textContent + (b.value || '')));
      if (searchBtn) { searchBtn.click(); results.push('clicked search'); }
      return results;
    }, year, month).catch(() => []);

    if (dateSet.length > 0) {
      console.log(`[comprobantes] date set: ${JSON.stringify(dateSet)}`);
      await sleep(3000);
      await page.waitForNetworkIdle({ timeout: 10000 }).catch(() => {});
    }

    // 5. Try to parse comprobantes from any table on the page
    const comprobantes = await page.evaluate(() => {
      const results = [];
      const tables = document.querySelectorAll('table');
      for (const table of tables) {
        const rows = Array.from(table.querySelectorAll('tr'));
        if (rows.length < 2) continue; // skip tables with no data rows
        // Try to find header row
        const headerRow = rows[0];
        const headers = Array.from(headerRow.querySelectorAll('th, td')).map(c => c.textContent.trim().toLowerCase());
        // Look for tables that have comprobante-like headers
        const hasRelevantHeaders = headers.some(h => /fecha|emisor|razon|tipo|importe|monto|comprobante|nro|numero/i.test(h));
        if (!hasRelevantHeaders && rows.length < 5) continue;

        for (let i = 1; i < rows.length; i++) {
          const cells = Array.from(rows[i].querySelectorAll('td')).map(c => c.textContent.trim());
          if (cells.length < 2) continue;
          // Try to extract fields based on position or header mapping
          const obj = {};
          headers.forEach((h, idx) => {
            if (idx < cells.length) obj[h] = cells[idx];
          });
          // Also store raw cells
          obj._raw = cells.join(' | ');
          if (cells.some(c => /\d/.test(c))) results.push(obj);
        }
      }
      return results.slice(0, 50);
    }).catch(() => []);

    console.log(`[comprobantes] parsed ${comprobantes.length} rows`);

    // Take debug screenshot
    const shot = await page.screenshot({ encoding: 'base64' }).catch(() => null);

    // Map parsed data to normalized comprobantes format
    const normalizedComprobantes = comprobantes.map((c, idx) => {
      const raw = c._raw || '';
      return {
        id: `arca-${idx}-${Date.now()}`,
        razonSocial: c['razón social'] || c['razon social'] || c['emisor'] || c['denominación'] || c['denominacion'] || raw.split('|')[0]?.trim() || 'Sin datos',
        tipo: c['tipo'] || c['tipo comp.'] || c['comprobante'] || '',
        nroComprobante: c['nro.'] || c['número'] || c['numero'] || c['nro'] || c['punto de vta.'] || '',
        fecha: c['fecha'] || c['fecha emisión'] || c['fecha emision'] || '',
        importeTotal: c['imp. total'] || c['importe'] || c['monto'] || c['total'] || c['imp.total'] || '',
        _raw: raw,
      };
    });

    return res.json({
      ok: true,
      debug: comprobantes.length === 0,
      title,
      urlAfterNav: page.url(),
      comprobantes: normalizedComprobantes,
      shot: comprobantes.length === 0 ? shot : null, // only send screenshot if no data found
      pageBodyPreview: comprobantes.length === 0 ? pageInfo.bodyText.slice(0, 1000) : undefined,
    });

  } catch (err) {
    console.error('[comprobantes error]', err.message);
    res.json({ ok: false, error: 'error_portal', msg: 'Error al navegar el portal de ARCA: ' + err.message });
  }
});

app.listen(PORT, () => console.log(`[deduxi-backend] listening on :${PORT}`));
