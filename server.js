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
   Strategy (based on live Chrome observation 2026-03-13):
     1. Go to ARCA portal (portalcf.cloud.afip.gob.ar)
     2. Click "Mis Comprobantes" with REAL mouse (jQuery handler, <a class="full-width">)
     3. DO NOT block window.open — let it create the popup naturally
     4. Capture popup via page.on('popup'), scrape the DataTables table
     5. Close popup page when done to free memory
   Key: The portal's jQuery click handler makes an API call that creates a session
   on fes.afip.gob.ar. Without this step, direct URL returns "Su sesión ha expirado".
───────────────────────────────────────── */
app.post('/api/arca/fetch-comprobantes', async (req, res) => {
  const { sessionId, periodo } = req.body;
  const s = sessions.get(sessionId);
  if (!s || !s.authenticated)
    return res.json({ ok: false, error: 'sesion_expirada', msg: 'La sesión expiró. Volvé a conectar con ARCA.' });

  const { browser, page } = s;
  const [year, month] = (periodo || new Date().toISOString().slice(0, 7)).split('-');
  const debugLog = [];
  let compPage = null; // will hold the popup page — MUST be closed at the end

  try {
    console.log(`[comprobantes] fetching for ${year}-${month}`);
    debugLog.push(`start: ${page.url()}`);

    // ── STEP 1: Go to the ARCA portal ──
    await page.goto('https://portalcf.cloud.afip.gob.ar/portal/app/', {
      waitUntil: 'networkidle2', timeout: 30000,
    }).catch(() => {});
    await sleep(4000);

    const portalTitle = await page.title().catch(() => '');
    debugLog.push(`portal: ${page.url()} (${portalTitle})`);
    console.log(`[comprobantes] portal: ${portalTitle}`);

    // ── STEP 2: Set up popup listener BEFORE clicking ──
    const popupPromise = new Promise(resolve => {
      page.once('popup', p => { console.log('[comprobantes] popup caught!'); resolve(p); });
      setTimeout(() => resolve(null), 20000); // 20s timeout
    });

    // ── STEP 3: Find "Mis Comprobantes" and click with REAL mouse ──
    // Structure: <a class="full-width"><div class="panel-body"><h3>Mis Comprobantes</h3></div></a>
    const coords = await page.evaluate(() => {
      const els = Array.from(document.querySelectorAll('h3, h4, h5, a, span, div'));
      const el = els.find(e => /^mis\s*comprobantes$/i.test(e.textContent?.trim()));
      if (el) {
        const clickTarget = el.closest('a') || el.closest('[role="button"]') || el;
        const r = clickTarget.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          return { x: Math.round(r.x + r.width/2), y: Math.round(r.y + r.height/2), text: el.textContent.trim(), tag: clickTarget.tagName };
        }
      }
      return null;
    }).catch(() => null);

    if (coords && coords.x > 0) {
      debugLog.push(`clicking "${coords.text}" <${coords.tag}> at (${coords.x}, ${coords.y})`);
      console.log(`[comprobantes] clicking at (${coords.x}, ${coords.y})`);
      await page.mouse.click(coords.x, coords.y);
    } else {
      debugLog.push('element not found, trying JS click');
      await page.evaluate(() => {
        const el = Array.from(document.querySelectorAll('h3')).find(e => /mis\s*comprobantes/i.test(e.textContent));
        if (el) (el.closest('a') || el).click();
      }).catch(() => {});
    }

    // ── STEP 4: Wait for the popup (Mis Comprobantes opens in new tab) ──
    compPage = await popupPromise;
    debugLog.push(`popup: ${compPage ? 'YES' : 'NO'}`);
    console.log(`[comprobantes] popup: ${!!compPage}`);

    if (compPage) {
      // Wait for the comprobantes page to fully load
      try {
        await compPage.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
      } catch (_) {}
      await sleep(4000);

      // Wait for DataTable to render
      await compPage.waitForSelector('table, .dataTables_wrapper', { timeout: 15000 }).catch(() => {});
      await sleep(2000);

      const compUrl = compPage.url();
      const compTitle = await compPage.title().catch(() => '');
      debugLog.push(`compPage: ${compUrl} (${compTitle})`);
      console.log(`[comprobantes] compPage: ${compUrl} title: ${compTitle}`);
    } else {
      // Popup didn't open — check if window.open was called but blocked
      debugLog.push('no popup — checking for URL...');
      // Try to get the URL from a captured window.open
      const openUrl = await page.evaluate(() => window.__capturedOpenUrl).catch(() => null);
      if (openUrl) debugLog.push(`captured URL: ${openUrl}`);

      // As last resort, navigate main page directly
      debugLog.push('trying direct URL as last resort...');
      await page.goto('https://fes.afip.gob.ar/mcmp/jsp/index.do', {
        waitUntil: 'networkidle2', timeout: 30000,
      }).catch(() => {});
      await sleep(3000);
      compPage = page; // use main page
      debugLog.push(`fallback: ${page.url()} (${await page.title().catch(() => '')})`);
    }

    // ── STEP 5: Parse the DataTables table from compPage ──
    // Headers: Fecha | Tipo | Número | Denominación Emisor | Imp. Total
    const parsed = await compPage.evaluate(() => {
      const results = [];
      const tables = document.querySelectorAll('table');

      for (const table of tables) {
        const headerRow = table.querySelector('thead tr');
        if (!headerRow) continue;
        const headers = Array.from(headerRow.querySelectorAll('th')).map(c => c.textContent.trim().toLowerCase());

        // Verify this is the comprobantes table
        const hasDate = headers.some(h => /fecha/i.test(h));
        const hasEmitOrImp = headers.some(h => /emisor|denominaci|imp|total/i.test(h));
        if (!hasDate || !hasEmitOrImp) continue;

        const bodyRows = Array.from(table.querySelectorAll('tbody tr'));
        for (const row of bodyRows) {
          const cells = Array.from(row.querySelectorAll('td')).map(c => c.textContent.trim());
          if (cells.length < 3 || cells.every(c => !c)) continue;

          const obj = {};
          headers.forEach((h, i) => { if (i < cells.length) obj[h] = cells[i]; });
          obj._raw = cells.join(' | ');
          results.push(obj);
        }
      }
      return results;
    }).catch(() => []);

    debugLog.push(`parsed ${parsed.length} rows`);
    console.log(`[comprobantes] parsed ${parsed.length} rows`);
    if (parsed.length > 0) console.log(`[comprobantes] first:`, JSON.stringify(parsed[0]));

    // ── STEP 6: Handle pagination ──
    if (parsed.length > 0) {
      let pageNum = 2;
      while (pageNum <= 10) {
        const hasNext = await compPage.evaluate(() => {
          const next = document.querySelector('.paginate_button.next:not(.disabled), .next:not(.disabled) a');
          if (next) { next.click(); return true; }
          return false;
        }).catch(() => false);
        if (!hasNext) break;
        await sleep(2000);

        const moreRows = await compPage.evaluate(() => {
          const table = document.querySelector('table thead');
          if (!table) return [];
          const headers = Array.from(table.closest('table').querySelectorAll('thead th')).map(c => c.textContent.trim().toLowerCase());
          return Array.from(table.closest('table').querySelectorAll('tbody tr')).map(row => {
            const cells = Array.from(row.querySelectorAll('td')).map(c => c.textContent.trim());
            if (cells.length < 3 || cells.every(c => !c)) return null;
            const obj = {};
            headers.forEach((h, i) => { if (i < cells.length) obj[h] = cells[i]; });
            obj._raw = cells.join(' | ');
            return obj;
          }).filter(Boolean);
        }).catch(() => []);
        if (moreRows.length === 0) break;
        parsed.push(...moreRows);
        debugLog.push(`page ${pageNum}: +${moreRows.length}`);
        pageNum++;
      }
    }

    // Debug: capture page state
    const bodyPreview = await compPage.evaluate(() => document.body?.innerText?.slice(0, 2000) || '').catch(() => '');
    const lastShot = await debugShot(compPage);
    const finalUrl = compPage.url();
    const finalTitle = await compPage.title().catch(() => '');

    // ── STEP 7: Close popup page to free memory ──
    if (compPage && compPage !== page) {
      await compPage.close().catch(() => {});
      compPage = null;
    }

    // Normalize
    const normalized = parsed.map((c, idx) => ({
      id: `arca-${idx}-${Date.now()}`,
      razonSocial: c['denominación emisor'] || c['denominacion emisor'] || c['emisor'] || 'Sin datos',
      tipo: c['tipo'] || '',
      nroComprobante: c['número'] || c['numero'] || '',
      fecha: c['fecha'] || '',
      importeTotal: c['imp. total'] || c['imp.total'] || c['importe total'] || '',
      _raw: c._raw || '',
    }));

    console.log(`[comprobantes] FINAL: ${normalized.length} comprobantes`);
    debugLog.push(`FINAL: ${normalized.length} comprobantes`);

    return res.json({
      ok: true,
      debug: normalized.length === 0,
      title: finalTitle,
      urlAfterNav: finalUrl,
      comprobantes: normalized,
      shot: normalized.length === 0 ? lastShot : null,
      pageBodyPreview: normalized.length === 0 ? bodyPreview?.slice(0, 1500) : undefined,
      debugLog,
    });

  } catch (err) {
    console.error('[comprobantes error]', err.message, err.stack);
    // Clean up popup if it was opened
    if (compPage && compPage !== page) await compPage.close().catch(() => {});
    const shot = await debugShot(page).catch(() => null);
    res.json({ ok: false, error: 'error_portal', msg: err.message, debugLog, shot });
  }
});

app.listen(PORT, () => console.log(`[deduxi-backend] listening on :${PORT}`));
