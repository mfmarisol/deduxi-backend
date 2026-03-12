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

    // 3. Clear and type CUIT using element handle
    const { el: cuitEl } = cuitResult;
    await cuitEl.click({ clickCount: 3 });
    await sleep(100);
    await cuitEl.type(cuitRaw, { delay: 40 });

    // 4. Click "Siguiente" — ARCA button id is F1:btnSiguiente
    const siguienteResult = await findElement(page, [
      '#F1\\:btnSiguiente',
      'input[value="Siguiente"]',
      'input[id*="Siguiente"]',
      'input[type="submit"]',
      'button[type="submit"]',
    ], { timeout: 5000 });

    if (!siguienteResult) {
      await browser.close();
      return res.json({ ok: false, error: 'error_conexion', msg: 'No se encontró el botón Siguiente en ARCA.' });
    }

    // Click and wait for navigation
    await Promise.all([
      siguienteResult.el.click(),
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {}),
    ]);

    await sleep(2000);
    console.log('[start] after Siguiente, url:', page.url());

    // 5. Check for CUIT-level error
    const errText = await page.$eval('#F1\\:msg', el => el.textContent.trim()).catch(() => '');
    if (errText && errText.length > 2) {
      await browser.close();
      return res.json({ ok: false, error: 'cuit_no_encontrado', msg: errText });
    }

    // 6. Wait for captcha solution input (confirms we're on the password page)
    const captchaInputResult = await findElement(page, [
      '#F1\\:captchaSolutionInput',
      'input[id*="captcha"]',
      'input[name*="captcha"]',
      'input[placeholder*="aptcha"]',
    ], { timeout: 15000 });

    if (!captchaInputResult) {
      const shot = await debugShot(page);
      console.error('[start] captcha input not found. URL:', page.url());
      await browser.close();
      return res.json({
        ok: false,
        error: 'error_conexion',
        msg: 'No apareció la pantalla de clave fiscal. Verificá que el CUIT esté registrado en ARCA.',
      });
    }

    // 7. Capture CAPTCHA image
    const captchaEl =
      (await page.$('img[alt*="aptcha"]')) ||
      (await page.$('img[alt*="APTCHA"]')) ||
      (await page.$('img[src*="captcha"]')) ||
      (await page.$('img[src*="Captcha"]'));

    if (!captchaEl) {
      await browser.close();
      return res.json({
        ok: false,
        error: 'captcha_no_encontrado',
        msg: 'No se pudo capturar la imagen del CAPTCHA de ARCA.',
      });
    }

    const captchaB64 = await captchaEl.screenshot({ encoding: 'base64' });
    console.log('[start] captcha captured, size:', captchaB64.length);

    // 8. Store session
    const sessionId = uuidv4();
    sessions.set(sessionId, { browser, page, createdAt: Date.now() });

    console.log(`[start] session ${sessionId} created`);
    res.json({ ok: true, sessionId, captcha: `data:image/png;base64,${captchaB64}` });

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
  if (!sessionId || !clave || !captchaSolution)
    return res.json({ ok: false, error: 'faltan_campos' });

  const s = sessions.get(sessionId);
  if (!s)
    return res.json({ ok: false, error: 'sesion_expirada', msg: 'La sesión expiró. Empezá de nuevo.' });

  const { browser, page } = s;

  try {
    // Find and fill password field
    const passResult = await findElement(page, [
      '#F1\\:password',
      'input[id$=":password"]',
      'input[id*="password"]',
      'input[type="password"]',
    ]);

    if (passResult) {
      await passResult.el.click({ clickCount: 3 });
      await passResult.el.type(clave, { delay: 30 });
    } else {
      throw new Error('No se encontró el campo de clave fiscal');
    }

    // Find and fill captcha field
    const captchaFieldResult = await findElement(page, [
      '#F1\\:captchaSolutionInput',
      'input[id*="captcha"]',
      'input[name*="captcha"]',
    ]);

    if (captchaFieldResult) {
      await captchaFieldResult.el.click({ clickCount: 3 });
      await captchaFieldResult.el.type(captchaSolution.trim(), { delay: 30 });
    } else {
      throw new Error('No se encontró el campo de CAPTCHA');
    }

    // Click Ingresar
    const ingresarResult = await findElement(page, [
      'input[value="Ingresar"]',
      'button[value="Ingresar"]',
      'input[type="submit"]',
      'button[type="submit"]',
    ], { timeout: 5000 });

    if (!ingresarResult) throw new Error('No se encontró el botón Ingresar');

    await Promise.all([
      ingresarResult.el.click(),
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {}),
    ]);

    await sleep(1000);

    const url = page.url();
    console.log('[complete] after submit, url:', url);
    const loginSucceeded = !url.includes('login.xhtml');

    if (loginSucceeded) {
      console.log(`[complete] login OK, session ${sessionId}`);
      sessions.delete(sessionId);
      browser.close().catch(() => {});
      return res.json({ ok: true });
    }

    // Still on login page → parse error
    const errText = await page.$eval('#F1\\:msg', el => el.textContent.trim()).catch(() => '');
    console.log('[complete] login failed, errText:', errText);
    const isCaptchaErr = /captcha|imagen|código|caracter/i.test(errText);

    if (isCaptchaErr) {
      try {
        const refreshBtn =
          (await page.$('a[id*="refresh"]')) ||
          (await page.$('a[onclick*="captcha"]')) ||
          (await page.$('[id*="refresh"]'));
        if (refreshBtn) {
          await refreshBtn.click();
          await sleep(900);
        }
      } catch (_) {}

      const captchaEl =
        (await page.$('img[alt*="aptcha"]')) ||
        (await page.$('img[src*="captcha"]'));
      const newCaptcha = captchaEl
        ? `data:image/png;base64,${await captchaEl.screenshot({ encoding: 'base64' })}`
        : null;

      return res.json({
        ok: false,
        error: 'captcha_incorrecto',
        msg: 'El código de la imagen no era correcto. Intentá de nuevo.',
        captcha: newCaptcha,
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
    const refreshBtn =
      (await page.$('a[id*="refresh"]')) ||
      (await page.$('a[onclick*="captcha"]'));
    if (refreshBtn) {
      await refreshBtn.click();
      await sleep(900);
    }
    const captchaEl =
      (await page.$('img[alt*="aptcha"]')) ||
      (await page.$('img[src*="captcha"]'));
    const b64 = captchaEl
      ? await captchaEl.screenshot({ encoding: 'base64' })
      : null;
    res.json({ ok: !!b64, captcha: b64 ? `data:image/png;base64,${b64}` : null });
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

app.listen(PORT, () => console.log(`[deduxi-backend] listening on :${PORT}`));
