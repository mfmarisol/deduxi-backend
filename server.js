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
   Strategy:
     1. Navigate to ARCA portal
     2. Click "Mis Comprobantes" — let the popup open naturally
     3. Capture the popup page via Puppeteer's 'popup' event
     4. On the comprobantes page, click "Recibidos", set dates, click search
     5. Parse the HTML table with results
   ← { ok, comprobantes: [...], debug info }
───────────────────────────────────────── */
app.post('/api/arca/fetch-comprobantes', async (req, res) => {
  const { sessionId, periodo } = req.body;
  const s = sessions.get(sessionId);
  if (!s || !s.authenticated)
    return res.json({ ok: false, error: 'sesion_expirada', msg: 'La sesión expiró. Volvé a conectar con ARCA.' });

  const { browser, page } = s;
  const [year, month] = (periodo || new Date().toISOString().slice(0, 7)).split('-');
  const debugLog = [];

  try {
    console.log(`[comprobantes] fetching for ${year}-${month}`);

    // ── STEP 1: Go to the ARCA portal ──
    debugLog.push(`current url: ${page.url()}`);
    await page.goto('https://portalcf.cloud.afip.gob.ar/portal/app/', {
      waitUntil: 'networkidle2', timeout: 30000,
    }).catch(() => {});
    await sleep(3000);

    const portalTitle = await page.title().catch(() => '');
    debugLog.push(`portal: ${page.url()} (${portalTitle})`);
    console.log(`[comprobantes] portal loaded: ${portalTitle}`);

    // ── STEP 2: Wait for Angular to fully load the portal ──
    await page.waitForSelector('[ng-click], .card, [ng-repeat]', { timeout: 10000 }).catch(() => {});
    await sleep(2000);

    // Dump portal structure for debug
    const portalInfo = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('[ng-click]'));
      return cards.map(c => ({
        tag: c.tagName,
        text: c.textContent?.trim().slice(0, 80),
        ngClick: c.getAttribute('ng-click')?.slice(0, 200),
        rect: c.getBoundingClientRect ? { x: c.getBoundingClientRect().x, y: c.getBoundingClientRect().y, w: c.getBoundingClientRect().width, h: c.getBoundingClientRect().height } : null,
      })).filter(c => c.text);
    }).catch(() => []);
    debugLog.push(`portal ng-click elements: ${portalInfo.length}`);
    console.log('[comprobantes] portal elements:', JSON.stringify(portalInfo.slice(0, 15)));

    // ── STEP 3: Find "Mis Comprobantes" and get its coordinates for REAL click ──
    // Also intercept window.open to capture URL
    await page.evaluate(() => {
      window.__capturedOpenUrl = null;
      const origOpen = window.open;
      window.open = function(url, ...args) {
        window.__capturedOpenUrl = url;
        return origOpen.call(window, url, ...args);
      };
    });

    // Set up popup listener BEFORE clicking
    let popupPage = null;
    const popupPromise = new Promise(resolve => {
      const popupHandler = (newPage) => {
        console.log('[comprobantes] popup event fired');
        popupPage = newPage;
        resolve(newPage);
      };
      page.once('popup', popupHandler);

      const targetHandler = async (target) => {
        if (target.type() === 'page') {
          const p = await target.page().catch(() => null);
          if (p && !popupPage) {
            console.log('[comprobantes] targetcreated event fired');
            popupPage = p;
            resolve(p);
          }
        }
      };
      browser.on('targetcreated', targetHandler);

      setTimeout(() => {
        page.removeListener('popup', popupHandler);
        browser.removeListener('targetcreated', targetHandler);
        resolve(null);
      }, 15000);
    });

    // Find the element coordinates and do a REAL Puppeteer click (mouse events)
    const clickTarget = await page.evaluate(() => {
      // Strategy 1: Find by ng-click containing "comprobante"
      const ngEls = Array.from(document.querySelectorAll('[ng-click]'));
      const byNg = ngEls.find(el => /comprobante/i.test(el.getAttribute('ng-click') || ''));
      if (byNg) {
        const r = byNg.getBoundingClientRect();
        return { found: true, method: 'ng-click', text: byNg.textContent?.trim().slice(0, 60), x: r.x + r.width/2, y: r.y + r.height/2, ngClick: byNg.getAttribute('ng-click')?.slice(0, 200) };
      }

      // Strategy 2: Find by text "Mis Comprobantes" on leaf nodes
      const allEls = Array.from(document.querySelectorAll('*'));
      const textEl = allEls.find(el => {
        const text = el.textContent?.trim();
        return text && /^mis\s*comprobantes$/i.test(text) && el.children.length === 0;
      });
      if (textEl) {
        // Walk up to find the clickable parent (ng-click or card)
        const clickable = textEl.closest('[ng-click]') || textEl.closest('a') || textEl.closest('button') ||
                          textEl.closest('.card') || textEl.closest('[role="button"]') || textEl;
        const r = clickable.getBoundingClientRect();
        const attrs = {};
        for (const a of (clickable.attributes || [])) attrs[a.name] = a.value.slice(0, 200);
        return { found: true, method: 'text-match', text: textEl.textContent.trim(), tag: clickable.tagName, x: r.x + r.width/2, y: r.y + r.height/2, attrs };
      }

      // Strategy 3: Broader text match
      const broader = allEls.find(el => {
        const text = el.textContent?.trim().toLowerCase();
        return text && text.includes('mis comprobantes') && text.length < 40 && el.children.length <= 2;
      });
      if (broader) {
        const clickable = broader.closest('[ng-click]') || broader;
        const r = clickable.getBoundingClientRect();
        return { found: true, method: 'broad-text', text: broader.textContent.trim().slice(0, 60), x: r.x + r.width/2, y: r.y + r.height/2 };
      }

      return { found: false };
    }).catch(err => ({ error: err.message }));

    debugLog.push(`clickTarget: ${JSON.stringify(clickTarget)}`);
    console.log(`[comprobantes] clickTarget:`, JSON.stringify(clickTarget));

    if (clickTarget.found && clickTarget.x > 0 && clickTarget.y > 0) {
      // Use REAL Puppeteer mouse click — this triggers Angular event handlers properly
      await page.mouse.click(clickTarget.x, clickTarget.y);
      debugLog.push(`real click at (${clickTarget.x}, ${clickTarget.y})`);
      console.log(`[comprobantes] real click at (${clickTarget.x}, ${clickTarget.y})`);
    } else if (clickTarget.found) {
      // Fallback: JS click via evaluate
      await page.evaluate(() => {
        const ngEls = Array.from(document.querySelectorAll('[ng-click]'));
        const byNg = ngEls.find(el => /comprobante/i.test(el.getAttribute('ng-click') || ''));
        if (byNg) { byNg.click(); return; }
        const allEls = Array.from(document.querySelectorAll('*'));
        const textEl = allEls.find(el => /^mis\s*comprobantes$/i.test(el.textContent?.trim()) && el.children.length === 0);
        if (textEl) { const c = textEl.closest('[ng-click]') || textEl; c.click(); }
      });
      debugLog.push('fallback JS click');
    }

    await sleep(5000); // Give Angular time to process the click and open the service

    // ── STEP 4: Check what happened — popup, captured URL, or navigation ──
    const popup = await popupPromise;
    const capturedUrl = await page.evaluate(() => window.__capturedOpenUrl).catch(() => null);
    const currentUrl = page.url();
    debugLog.push(`popup: ${popup ? 'yes' : 'no'}, capturedUrl: ${capturedUrl || 'none'}, currentUrl: ${currentUrl}`);
    console.log(`[comprobantes] popup=${!!popup}, capturedUrl=${capturedUrl}, currentUrl=${currentUrl}`);

    let compPage = null;

    if (popup) {
      compPage = popup;
      debugLog.push('using popup page');
      try {
        await compPage.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
      } catch (_) {}
      await sleep(3000);
    } else if (capturedUrl) {
      debugLog.push(`opening captured URL: ${capturedUrl}`);
      compPage = await browser.newPage();
      await compPage.setViewport({ width: 1280, height: 900 });
      await compPage.goto(capturedUrl, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
      await sleep(3000);
    } else {
      // Check if the page URL changed (maybe navigation instead of popup)
      if (currentUrl !== 'https://portalcf.cloud.afip.gob.ar/portal/app/' &&
          currentUrl !== 'about:blank') {
        debugLog.push('page navigated to: ' + currentUrl);
        compPage = page;
      } else {
        // Try to extract the service URL from Angular scope
        const angularUrl = await page.evaluate(() => {
          try {
            const scope = angular.element(document.querySelector('[ng-controller]')).scope();
            if (scope && scope.servicios) {
              const comp = scope.servicios.find(s => /comprobante/i.test(s.desc || s.nombre || s.titulo || ''));
              if (comp) return comp.url || comp.link || comp.href || JSON.stringify(comp);
            }
          } catch (_) {}
          // Also try to find URLs in script tags or inline JS
          const scripts = document.querySelectorAll('script');
          for (const s of scripts) {
            const match = s.textContent?.match(/https?:\/\/[^"'\s]+comprobante[^"'\s]*/i);
            if (match) return match[0];
          }
          return null;
        }).catch(() => null);

        if (angularUrl && angularUrl.startsWith('http')) {
          debugLog.push(`angular scope URL: ${angularUrl}`);
          compPage = await browser.newPage();
          await compPage.setViewport({ width: 1280, height: 900 });
          await compPage.goto(angularUrl, { waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
          await sleep(3000);
        } else {
          debugLog.push('no popup, no URL — using portal page as fallback');
          if (angularUrl) debugLog.push(`angular data: ${angularUrl}`);
          compPage = page;
        }
      }
    }

    let lastUrl = compPage.url();
    let lastTitle = await compPage.title().catch(() => '');
    debugLog.push(`comp page: ${lastUrl} (${lastTitle})`);
    console.log(`[comprobantes] comp page: ${lastUrl} title: ${lastTitle}`);

    // ── STEP 5: If we're on a comprobantes page, interact with the form ──
    // Look for "Recibidos" tab/link and click it
    const clickRecib = await compPage.evaluate(() => {
      const els = Array.from(document.querySelectorAll('a, button, li, span, div, input[type="button"], input[type="submit"], label, tab, [role="tab"]'));
      const recib = els.find(el => /recib/i.test(el.textContent?.trim()) && el.textContent.trim().length < 40);
      if (recib) {
        const clickable = recib.closest('a') || recib.closest('button') || recib.closest('li') || recib.closest('[role="tab"]') || recib;
        clickable.click();
        return `clicked: ${recib.textContent.trim()} (${clickable.tagName})`;
      }
      return null;
    }).catch(() => null);

    if (clickRecib) {
      debugLog.push(`recibidos: ${clickRecib}`);
      console.log(`[comprobantes] ${clickRecib}`);
      await sleep(3000);
    }

    // ── STEP 6: Set date range and search ──
    const lastDay = new Date(parseInt(year), parseInt(month), 0).getDate();
    const fechaDesde = `01/${month}/${year}`;
    const fechaHasta = `${lastDay}/${month}/${year}`;

    const dateResult = await compPage.evaluate((desde, hasta, y, m) => {
      const results = [];
      const allInputs = Array.from(document.querySelectorAll('input, select'));

      // Strategy A: Find date inputs by name/id/placeholder
      const dateInputs = allInputs.filter(el =>
        el.type !== 'hidden' && el.type !== 'submit' && el.type !== 'button' &&
        /fecha|date|desde|hasta|inicio|fin|period/i.test(el.id + el.name + (el.placeholder || '') + (el.getAttribute('aria-label') || ''))
      );

      // If we have exactly 2 date inputs, assume first=desde second=hasta
      if (dateInputs.length >= 2) {
        const setVal = (inp, val) => {
          inp.value = val;
          inp.dispatchEvent(new Event('input', { bubbles: true }));
          inp.dispatchEvent(new Event('change', { bubbles: true }));
          inp.dispatchEvent(new Event('blur', { bubbles: true }));
        };
        setVal(dateInputs[0], desde);
        setVal(dateInputs[1], hasta);
        results.push(`dates: ${desde} - ${hasta} (by position)`);
      } else {
        // Try matching by keyword
        for (const inp of dateInputs) {
          const key = (inp.id + inp.name + (inp.placeholder || '')).toLowerCase();
          if (/desde|inicio|from|start/i.test(key)) {
            inp.value = desde;
            inp.dispatchEvent(new Event('change', { bubbles: true }));
            results.push(`desde=${desde}`);
          } else if (/hasta|fin|end|to/i.test(key)) {
            inp.value = hasta;
            inp.dispatchEvent(new Event('change', { bubbles: true }));
            results.push(`hasta=${hasta}`);
          }
        }
      }

      // Also try any generic date-looking inputs (dd/mm/yyyy format in value)
      if (results.length === 0) {
        const possibleDates = allInputs.filter(el =>
          el.type === 'text' && /^\d{2}\/\d{2}\/\d{4}$/.test(el.value)
        );
        if (possibleDates.length >= 2) {
          possibleDates[0].value = desde;
          possibleDates[0].dispatchEvent(new Event('change', { bubbles: true }));
          possibleDates[1].value = hasta;
          possibleDates[1].dispatchEvent(new Event('change', { bubbles: true }));
          results.push(`dates by value pattern: ${desde} - ${hasta}`);
        }
      }

      // Month/year selects
      const selects = allInputs.filter(el => el.tagName === 'SELECT');
      for (const sel of selects) {
        const opts = Array.from(sel.options).map(o => o.text.toLowerCase());
        if (opts.some(o => /enero|febrero|marzo|abril|mayo|junio/i.test(o))) {
          const monthNames = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
          const monthIdx = parseInt(m) - 1;
          for (let i = 0; i < sel.options.length; i++) {
            if (sel.options[i].text.toLowerCase().includes(monthNames[monthIdx]) ||
                sel.options[i].value === m || sel.options[i].value === String(parseInt(m))) {
              sel.selectedIndex = i;
              sel.dispatchEvent(new Event('change', { bubbles: true }));
              results.push(`month=${sel.options[i].text}`);
              break;
            }
          }
        }
      }

      // Click Buscar/Consultar button
      const btns = Array.from(document.querySelectorAll('input[type="submit"], input[type="button"], button'));
      const searchBtn = btns.find(b =>
        /buscar|consultar|search|filtrar/i.test((b.textContent || '') + (b.value || ''))
      );
      if (searchBtn) {
        searchBtn.click();
        results.push(`search: ${searchBtn.value || searchBtn.textContent?.trim()}`);
      }

      // Also list all visible inputs for debug
      const inputInfo = allInputs
        .filter(el => el.offsetWidth > 0 && el.type !== 'hidden')
        .map(el => ({ id: el.id, name: el.name, type: el.type, val: el.value?.slice(0, 30) }))
        .slice(0, 20);

      return { actions: results, inputs: inputInfo };
    }, fechaDesde, fechaHasta, year, month).catch(e => ({ error: e.message }));

    debugLog.push(`dates: ${JSON.stringify(dateResult?.actions || dateResult)}`);
    console.log(`[comprobantes] date result:`, JSON.stringify(dateResult));

    if (dateResult?.actions?.length > 0) {
      await sleep(4000);
      await compPage.waitForNetworkIdle({ timeout: 10000 }).catch(() => {});
      await sleep(2000);
    }

    // ── STEP 7: Parse comprobantes from the page ──
    // The ARCA page uses a DataTable with headers:
    // Fecha | Tipo | Número | Denominación Emisor | Imp. Total
    const parsed = await compPage.evaluate(() => {
      const results = [];

      // Strategy 1: HTML tables — find the one with comprobante-like headers
      const tables = document.querySelectorAll('table');
      for (const table of tables) {
        const headerRow = table.querySelector('thead tr') || table.querySelector('tr');
        if (!headerRow) continue;
        const headers = Array.from(headerRow.querySelectorAll('th, td')).map(c => c.textContent.trim().toLowerCase());

        // Check if this looks like a comprobantes table
        const isCompTable = headers.some(h => /fecha/i.test(h)) &&
                           headers.some(h => /tipo|n[uú]mero|emisor|importe|imp/i.test(h));

        if (!isCompTable && tables.length > 1) continue; // Skip non-comprobante tables if multiple

        // Parse body rows
        const bodyRows = table.querySelector('tbody')
          ? Array.from(table.querySelectorAll('tbody tr'))
          : Array.from(table.querySelectorAll('tr')).slice(1);

        for (const row of bodyRows) {
          const cells = Array.from(row.querySelectorAll('td')).map(c => c.textContent.trim());
          if (cells.length < 2) continue;
          // Skip rows that look like headers or empty
          if (cells.every(c => !c || c.length === 0)) continue;

          const obj = {};
          headers.forEach((h, idx) => { if (idx < cells.length) obj[h] = cells[idx]; });
          obj._raw = cells.join(' | ');
          obj._source = 'table';
          obj._headerCount = headers.length;
          // Only include rows that have at least one number (date or amount)
          if (cells.some(c => /\d/.test(c))) results.push(obj);
        }
      }

      // Strategy 2: div/card based (Angular apps)
      if (results.length === 0) {
        const cards = document.querySelectorAll('[class*="comprobante"], [class*="resultado"], .dataTables_wrapper tr, [role="row"]');
        cards.forEach(card => {
          const text = card.innerText?.trim();
          if (text && text.length > 10 && /\d/.test(text) && !/novedades|alertas|portal/i.test(text)) {
            results.push({ _raw: text.replace(/\n/g, ' | '), _source: 'card' });
          }
        });
      }

      // Strategy 3: DataTables specific
      if (results.length === 0) {
        const dtRows = document.querySelectorAll('.dataTable tbody tr, #dataTable tbody tr, table.display tbody tr');
        dtRows.forEach(row => {
          const cells = Array.from(row.querySelectorAll('td')).map(c => c.textContent.trim());
          if (cells.length >= 3 && cells.some(c => /\d/.test(c))) {
            results.push({ _raw: cells.join(' | '), _source: 'datatable', cells });
          }
        });
      }

      return results.slice(0, 100);
    }).catch(() => []);

    debugLog.push(`parsed ${parsed.length} rows`);
    console.log(`[comprobantes] parsed ${parsed.length} rows`);
    if (parsed.length > 0) console.log(`[comprobantes] sample:`, JSON.stringify(parsed[0]));

    // ── STEP 8: If we got results, check if there are more pages ──
    if (parsed.length > 0) {
      // Try to get all pages of results
      const hasMorePages = await compPage.evaluate(() => {
        const pagination = document.querySelector('.paginate_button.next:not(.disabled), .pagination .next:not(.disabled), a[aria-label="Next"]');
        return !!pagination;
      }).catch(() => false);

      if (hasMorePages) {
        debugLog.push('pagination detected, clicking next...');
        let pageNum = 2;
        let maxPages = 5; // safety limit
        while (pageNum <= maxPages) {
          const clicked = await compPage.evaluate(() => {
            const nextBtn = document.querySelector('.paginate_button.next:not(.disabled), .pagination .next:not(.disabled) a, a[aria-label="Next"]');
            if (nextBtn) { nextBtn.click(); return true; }
            return false;
          }).catch(() => false);

          if (!clicked) break;
          await sleep(2000);

          const moreRows = await compPage.evaluate(() => {
            const results = [];
            const table = document.querySelector('table');
            if (!table) return results;
            const headerRow = table.querySelector('thead tr') || table.querySelector('tr');
            const headers = headerRow ? Array.from(headerRow.querySelectorAll('th, td')).map(c => c.textContent.trim().toLowerCase()) : [];
            const bodyRows = table.querySelector('tbody')
              ? Array.from(table.querySelectorAll('tbody tr'))
              : Array.from(table.querySelectorAll('tr')).slice(1);
            for (const row of bodyRows) {
              const cells = Array.from(row.querySelectorAll('td')).map(c => c.textContent.trim());
              if (cells.length < 2 || cells.every(c => !c)) continue;
              const obj = {};
              headers.forEach((h, idx) => { if (idx < cells.length) obj[h] = cells[idx]; });
              obj._raw = cells.join(' | ');
              obj._source = 'table';
              if (cells.some(c => /\d/.test(c))) results.push(obj);
            }
            return results;
          }).catch(() => []);

          if (moreRows.length === 0) break;
          parsed.push(...moreRows);
          debugLog.push(`page ${pageNum}: +${moreRows.length} rows`);
          pageNum++;
        }
      }
    }

    // Capture debug info
    const lastBodyPreview = await compPage.evaluate(() => document.body?.innerText?.slice(0, 2000) || '').catch(() => '');
    const lastShot = await debugShot(compPage);
    lastUrl = compPage.url();
    lastTitle = await compPage.title().catch(() => '');

    // Close extra pages
    if (compPage !== page) {
      // Keep compPage alive for debug but close later
      await compPage.close().catch(() => {});
    }

    // ── STEP 9: Normalize comprobantes ──
    const normalized = parsed.map((c, idx) => {
      const raw = c._raw || '';
      return {
        id: `arca-${idx}-${Date.now()}`,
        razonSocial: c['denominación emisor'] || c['denominacion emisor'] || c['razón social'] || c['razon social'] ||
                     c['emisor'] || c['denominación'] || c['denominacion'] || c['receptor'] ||
                     raw.split('|')[3]?.trim() || raw.split('|')[0]?.trim() || 'Sin datos',
        tipo: c['tipo'] || c['tipo comp.'] || c['comprobante'] || c['tipo comprobante'] || raw.split('|')[1]?.trim() || '',
        nroComprobante: c['número'] || c['numero'] || c['nro.'] || c['nro'] || c['punto de vta.'] || raw.split('|')[2]?.trim() || '',
        fecha: c['fecha'] || c['fecha emisión'] || c['fecha emision'] || c['fecha de emisión'] || raw.split('|')[0]?.trim() || '',
        importeTotal: c['imp. total'] || c['imp.total'] || c['importe total'] || c['importe'] || c['monto'] || c['total'] || '',
        _raw: raw,
      };
    });

    console.log(`[comprobantes] FINAL: ${normalized.length} comprobantes`);
    debugLog.push(`FINAL: ${normalized.length} comprobantes`);

    return res.json({
      ok: true,
      debug: normalized.length === 0,
      title: lastTitle,
      urlAfterNav: lastUrl,
      comprobantes: normalized,
      shot: normalized.length === 0 ? lastShot : null,
      pageBodyPreview: normalized.length === 0 ? lastBodyPreview?.slice(0, 1500) : undefined,
      debugLog,
      dateInputs: dateResult?.inputs || null,
    });

  } catch (err) {
    console.error('[comprobantes error]', err.message);
    res.json({ ok: false, error: 'error_portal', msg: 'Error al navegar el portal de ARCA: ' + err.message, debugLog });
  }
});

app.listen(PORT, () => console.log(`[deduxi-backend] listening on :${PORT}`));
