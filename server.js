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
    if (!origin) return cb(null, true); // server-to-server / curl
    const ok = ORIGINS.some(o => origin === o || origin.endsWith('.vercel.app'));
    cb(ok ? null : new Error('CORS'), ok);
  },
}));
app.use(express.json({ limit: '512kb' }));

/* ── Puppeteer launcher ── */
const CHROME_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';
const launchBrowser = () =>
  puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
      '--no-zygote',
    ],
  });

/* ── Session store (in-memory) ── */
// Map<sessionId, { browser, page, createdAt }>
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
   Body: { cuit: "20-12345678-9" }
   → Navigates to ARCA login, enters CUIT,
     gets to clave+captcha page.
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
    console.log(`[start] CUIT ${cuitRaw.slice(0,2)}***`);
    browser = await launchBrowser();
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // 1. Go to ARCA login
    await page.goto('https://auth.afip.gob.ar/contribuyente_/login.xhtml', {
      waitUntil: 'networkidle2',
      timeout: 25000,
    });

    // 2. Enter CUIT
    await page.waitForSelector('#F1\\:username', { timeout: 10000 });
    await page.type('#F1\\:username', cuitRaw, { delay: 40 });
    await page.click('input[value="Siguiente"]');

    // 3. Wait for navigation to clave page
    try {
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 12000 });
    } catch (_) {
      // might not navigate if CUIT is invalid — fall through to error check
    }

    // 4. Check for CUIT-level error
    const errText = await page.$eval('#F1\\:msg', el => el.textContent.trim()).catch(() => '');
    if (errText && errText.length > 2) {
      await browser.close();
      return res.json({ ok: false, error: 'cuit_no_encontrado', msg: errText });
    }

    // 5. Wait for the captcha solution input to confirm we're on the right page
    await page.waitForSelector('#F1\\:captchaSolutionInput', { timeout: 12000 });

    // 6. Screenshot the CAPTCHA image
    // Try multiple selectors in order of specificity
    const captchaEl =
      (await page.$('img[alt*="aptcha"]')) ||
      (await page.$('img[alt*="APTCHA"]')) ||
      (await page.$('img[src*="captcha"]')) ||
      (await page.$('img[src*="Captcha"]'));

    if (!captchaEl) {
      await browser.close();
      return res.json({ ok: false, error: 'captcha_no_encontrado', msg: 'No pudimos cargar el CAPTCHA de ARCA.' });
    }

    const captchaB64 = await captchaEl.screenshot({ encoding: 'base64' });

    // 7. Store session
    const sessionId = uuidv4();
    sessions.set(sessionId, { browser, page, createdAt: Date.now() });

    console.log(`[start] session ${sessionId} created`);
    res.json({ ok: true, sessionId, captcha: `data:image/png;base64,${captchaB64}` });

  } catch (err) {
    if (browser) browser.close().catch(() => {});
    console.error('[start error]', err.message);
    res.json({ ok: false, error: 'error_conexion', msg: 'No pudimos conectar con ARCA. Intentá de nuevo.' });
  }
});

/* ─────────────────────────────────────────
   POST /api/arca/complete
   Body: { sessionId, clave, captchaSolution }
   → Types clave + captcha, submits login.
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
    // Type clave fiscal (never logged)
    await page.click('#F1\\:password', { clickCount: 3 });
    await page.type('#F1\\:password', clave, { delay: 30 });

    // Type CAPTCHA solution
    await page.click('#F1\\:captchaSolutionInput', { clickCount: 3 });
    await page.type('#F1\\:captchaSolutionInput', captchaSolution.trim(), { delay: 30 });

    // Click Ingresar
    await Promise.all([
      page.click('input[value="Ingresar"]'),
      page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 18000 }).catch(() => {}),
    ]);

    const url = page.url();
    const loginSucceeded = !url.includes('login.xhtml');

    if (loginSucceeded) {
      console.log(`[complete] login OK, session ${sessionId}`);
      sessions.delete(sessionId);
      browser.close().catch(() => {});
      return res.json({ ok: true });
    }

    // Still on login page → parse error
    const errText = await page.$eval('#F1\\:msg', el => el.textContent.trim()).catch(() => '');
    const isCaptchaErr = /captcha|imagen|código/i.test(errText);

    if (isCaptchaErr) {
      // Refresh captcha image, keep session alive for retry
      try {
        const refreshBtn =
          (await page.$('a[id*="refresh"]')) ||
          (await page.$('a[onclick*="captcha"]')) ||
          (await page.$('[id*="refresh"]'));
        if (refreshBtn) {
          await refreshBtn.click();
          await new Promise(r => setTimeout(r, 900));
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

    // Wrong clave or CUIT mismatch
    sessions.delete(sessionId);
    browser.close().catch(() => {});
    return res.json({
      ok: false,
      error: 'clave_incorrecta',
      msg: errText || 'Clave fiscal incorrecta.',
    });

  } catch (err) {
    sessions.delete(sessionId);
    browser.close().catch(() => {});
    console.error('[complete error]', err.message);
    res.json({ ok: false, error: 'error_conexion', msg: 'Error al comunicarse con ARCA.' });
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
      await new Promise(r => setTimeout(r, 900));
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

app.listen(PORT, () => console.log(`[deduxi-backend] listening on :${PORT}`));
