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
  const { sessionId, clave, captchaSolution, cuit } = req.body;
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
      const userCuit = (cuit || '').replace(/\D/g, '');
      sessions.set(sessionId, { browser, page, createdAt: Date.now(), authenticated: true, cuit: userCuit });

      // ─── IMMEDIATELY scrape comprobantes while session is fresh ───
      const compDebug = [];
      let comprobantes = [];
      try {
        console.log('[complete] scraping comprobantes immediately...');
        const now = new Date();
        const yr = now.getFullYear();
        const mo = String(now.getMonth() + 1).padStart(2, '0');

        // Step A: We're already on the portal — call APIs to get sign+token
        compDebug.push('A: calling portal APIs...');
        const api = await page.evaluate(async (c) => {
          try {
            const r1 = await fetch(`/portal/api/servicios/${c}/servicio/mcmp`, { credentials: 'include' });
            const d1 = await r1.json();
            const r2 = await fetch(`/portal/api/servicios/${c}/servicio/mcmp/autorizacion`, { credentials: 'include' });
            const d2 = await r2.json();
            return { ok: true, url: d1?.servicio?.url, token: d2?.token, sign: d2?.sign };
          } catch (e) { return { ok: false, err: e.message }; }
        }, userCuit).catch(e => ({ ok: false, err: e.message }));

        compDebug.push(`A done: ok=${api.ok}, token=${!!api.token}, sign=${!!api.sign}`);

        if (api.ok && api.token && api.sign) {
          // Step B: POST sign+token to service URL
          compDebug.push('B: POSTing token+sign...');
          const svcUrl = api.url || 'https://fes.afip.gob.ar/mcmp/jsp/index.do';
          await Promise.all([
            page.evaluate((u, t, s) => {
              const f = document.createElement('form');
              f.method='POST'; f.action=u; f.style.display='none';
              [{n:'token',v:t},{n:'sign',v:s}].forEach(({n,v}) => {
                const i=document.createElement('input'); i.type='hidden'; i.name=n; i.value=v; f.appendChild(i);
              });
              document.body.appendChild(f); f.submit();
            }, svcUrl, api.token, api.sign),
            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 25000 }).catch(() => {}),
          ]).catch(() => {});
          await sleep(2000);
          compDebug.push(`B done: ${page.url()}`);

          // Step C: Select contribuyente (idContribuyente=0 = user's own CUIT)
          compDebug.push('C: selecting contribuyente...');
          await page.goto('https://fes.afip.gob.ar/mcmp/jsp/setearContribuyente.do?idContribuyente=0', {
            waitUntil: 'networkidle2', timeout: 20000,
          }).catch(() => {});
          await sleep(2000);
          compDebug.push(`C done: ${page.url()}`);

          // Step D: Go to Comprobantes Recibidos if not already there
          if (!/comprobantesRecibidos/i.test(page.url())) {
            compDebug.push('D: navigating to recibidos...');
            await page.goto('https://fes.afip.gob.ar/mcmp/jsp/comprobantesRecibidos.do', {
              waitUntil: 'networkidle2', timeout: 20000,
            }).catch(() => {});
            await sleep(2000);
            compDebug.push(`D done: ${page.url()}`);
          }

          // Step D2: Set date filter to full current month before loading data
          // Use today as end date — ARCA only has data up to yesterday
          const today = new Date();
          const dateFrom = `01/${mo}/${yr}`;
          const dateTo = `${String(today.getDate()).padStart(2,'0')}/${String(today.getMonth()+1).padStart(2,'0')}/${today.getFullYear()}`;
          const dateRange = `${dateFrom} - ${dateTo}`;
          compDebug.push(`D2: setting date range: ${dateRange}`);

          const dateResult = await page.evaluate((range, from, to) => {
            // Look for date range input
            const inputs = document.querySelectorAll('input[type="text"], input.form-control, input[name*="fecha"], input[name*="date"]');
            for (const input of inputs) {
              // Date range inputs typically contain "DD/MM/YYYY - DD/MM/YYYY"
              if (/\d{2}\/\d{2}\/\d{4}/.test(input.value) || input.id?.includes('fecha') || input.name?.includes('fecha')) {
                const old = input.value;
                // Use native setter to trigger change events
                const nativeSet = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
                nativeSet.call(input, range);
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
                // Also try jQuery trigger if available
                if (window.jQuery) window.jQuery(input).trigger('change').trigger('apply.daterangepicker');
                return { found: true, old, now: range, id: input.id, name: input.name };
              }
            }
            return { found: false, inputCount: inputs.length };
          }, dateRange, dateFrom, dateTo).catch(e => ({ found: false, err: e.message }));

          compDebug.push(`D2 date: ${JSON.stringify(dateResult)}`);

          // Click search/buscar/consultar button if present
          if (dateResult.found) {
            await page.evaluate(() => {
              const btns = Array.from(document.querySelectorAll('button, input[type="submit"], a.btn, .btn'));
              const searchBtn = btns.find(b => /buscar|consultar|filtrar|search/i.test(b.textContent || b.value || ''));
              if (searchBtn) { searchBtn.click(); return searchBtn.textContent.trim(); }
              return null;
            }).catch(() => {});
            await sleep(5000); // wait for table to reload with new date range
          }

          // Step E: Parse HTML table + handle pagination (click Next)
          compDebug.push('E: parsing table with pagination...');
          await page.waitForSelector('table', { timeout: 10000 }).catch(() => {});
          await sleep(3000);

          // Parse current page
          const parseCurrentPage = async () => {
            return page.evaluate(() => {
              const tables = document.querySelectorAll('table');
              for (const table of tables) {
                const headerRow = table.querySelector('thead tr') || table.querySelector('tr:first-child');
                if (!headerRow) continue;
                const headers = Array.from(headerRow.querySelectorAll('th, td')).map(c => c.textContent.trim().toLowerCase());
                if (headers.length < 3 || !headers.some(h => /fecha/i.test(h))) continue;
                const rows = [];
                for (const row of table.querySelectorAll('tbody tr')) {
                  const cells = Array.from(row.querySelectorAll('td')).map(c => c.textContent.trim());
                  if (cells.length < 3 || cells.every(c => !c)) continue;
                  if (cells.some(c => /no se encontraron|sin resultados/i.test(c))) continue;
                  const obj = {};
                  headers.forEach((h, i) => { if (i < cells.length) obj[h] = cells[i]; });
                  rows.push(obj);
                }
                return { rows, headers };
              }
              return { rows: [], headers: [] };
            }).catch(() => ({ rows: [], headers: [] }));
          };

          const firstPage = await parseCurrentPage();
          const allRows = [...firstPage.rows];
          compDebug.push(`E page1: ${firstPage.rows.length} rows, headers: [${firstPage.headers.join(', ')}]`);

          // Click "Next" for subsequent pages
          let pageNum = 2;
          while (pageNum <= 20 && allRows.length > 0) {
            const hasNext = await page.evaluate(() => {
              const nextBtn = document.querySelector('.paginate_button.next:not(.disabled), .next:not(.disabled) a, a.paginate_button.next:not(.disabled), li.next:not(.disabled) a');
              if (nextBtn) { nextBtn.click(); return true; }
              return false;
            }).catch(() => false);
            if (!hasNext) break;
            await sleep(2000);
            const nextPage = await parseCurrentPage();
            if (nextPage.rows.length === 0) break;
            allRows.push(...nextPage.rows);
            compDebug.push(`E page${pageNum}: +${nextPage.rows.length} rows`);
            pageNum++;
          }

          compDebug.push(`E total: ${allRows.length} rows`);

          // Normalize
          comprobantes = allRows.map((c, idx) => ({
            id: `arca-${idx}-${Date.now()}`,
            razonSocial: c['denominación emisor'] || c['denominacion emisor'] || c['emisor'] || 'Sin datos',
            tipo: c['tipo'] || '',
            nroComprobante: c['número'] || c['numero'] || '',
            fecha: c['fecha'] || '',
            importeTotal: c['imp. total'] || c['imp.total'] || c['importe total'] || '',
          }));

          compDebug.push(`FINAL: ${comprobantes.length} comprobantes`);
          console.log(`[complete] scraped ${comprobantes.length} comprobantes`);
        }
      } catch (compErr) {
        console.error('[complete] comprobantes error:', compErr.message);
        compDebug.push(`ERROR: ${compErr.message}`);
      }

      return res.json({
        ok: true,
        arcaSessionId: sessionId,
        landingUrl: url,
        comprobantes,
        compDebug,
      });
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
   Body: { sessionId, periodo: "2026-03", cuit: "20404927737" }
   Strategy v3 — Portal API approach (discovered 2026-03-13 via Chrome network inspection):
     1. Navigate to ARCA portal (reuses authenticated cookies)
     2. Call portal REST API: GET /portal/api/servicios/{CUIT}/servicio/mcmp  → service info
     3. Call portal REST API: GET /portal/api/servicios/{CUIT}/servicio/mcmp/autorizacion → creates SSO session
     4. Navigate to fes.afip.gob.ar/mcmp/jsp/index.do (session now valid)
     5. Parse the DataTables table (Fecha | Tipo | Número | Denominación Emisor | Imp. Total)
   Key insight: The autorizacion call creates the session on fes.afip.gob.ar.
   Without it, direct navigation returns "Su sesión ha expirado".
───────────────────────────────────────── */
app.post('/api/arca/fetch-comprobantes', async (req, res) => {
  const { sessionId, periodo, cuit } = req.body;
  const s = sessions.get(sessionId);
  if (!s || !s.authenticated)
    return res.json({ ok: false, error: 'sesion_expirada', msg: 'La sesión expiró. Volvé a conectar con ARCA.' });

  const { browser, page } = s;
  const [year, month] = (periodo || new Date().toISOString().slice(0, 7)).split('-');
  const userCuit = (cuit || s.cuit || '').replace(/\D/g, '');
  const debugLog = [];

  try {
    console.log(`[comprobantes] fetching for ${year}-${month}, CUIT: ${userCuit.slice(0,2)}***`);
    debugLog.push(`start: ${page.url()}, cuit: ${userCuit ? userCuit.slice(0,2) + '***' : 'MISSING'}`);

    if (!userCuit || userCuit.length !== 11) {
      debugLog.push('ERROR: CUIT missing or invalid');
      return res.json({ ok: false, error: 'cuit_missing', msg: 'Falta el CUIT para consultar comprobantes.', debugLog });
    }

    // ── STEP 1: Go to ARCA portal ──
    debugLog.push('step1: navigating to portal...');
    await page.goto('https://portalcf.cloud.afip.gob.ar/portal/app/', {
      waitUntil: 'networkidle2', timeout: 30000,
    }).catch(e => debugLog.push('step1 error: ' + e.message));
    await sleep(2000);
    debugLog.push(`step1 done: ${page.url()}`);

    // ── STEP 2: Call portal APIs to get sign+token ──
    debugLog.push('step2: calling portal APIs...');
    const apiResult = await page.evaluate(async (c) => {
      try {
        const r1 = await fetch(`/portal/api/servicios/${c}/servicio/mcmp`, { credentials: 'include' });
        const d1 = await r1.json();
        const r2 = await fetch(`/portal/api/servicios/${c}/servicio/mcmp/autorizacion`, { credentials: 'include' });
        const d2 = await r2.json();
        return { ok: true, url: d1?.servicio?.url, token: d2?.token, sign: d2?.sign, s1: r1.status, s2: r2.status };
      } catch (e) { return { ok: false, err: e.message }; }
    }, userCuit).catch(e => ({ ok: false, err: 'evaluate: ' + e.message }));

    debugLog.push(`step2: ok=${apiResult.ok}, token=${!!apiResult.token}, sign=${!!apiResult.sign}`);

    if (!apiResult.ok || !apiResult.token || !apiResult.sign) {
      const shot = await debugShot(page).catch(() => null);
      return res.json({ ok: false, error: 'api_error', msg: 'Error obteniendo token: ' + (apiResult.err || 'sin token/sign'), debugLog, shot });
    }

    // ── STEP 3: POST sign+token via form (mimics portal JS) ──
    debugLog.push('step3: POSTing token+sign...');
    const serviceUrl = apiResult.url || 'https://fes.afip.gob.ar/mcmp/jsp/index.do';

    await page.evaluate((url, token, sign) => {
      const f = document.createElement('form');
      f.method = 'POST'; f.action = url; f.style.display = 'none';
      [{n:'token',v:token},{n:'sign',v:sign}].forEach(({n,v}) => {
        const i = document.createElement('input'); i.type='hidden'; i.name=n; i.value=v; f.appendChild(i);
      });
      document.body.appendChild(f); f.submit();
    }, serviceUrl, apiResult.token, apiResult.sign).catch(e => debugLog.push('step3 form error: ' + e.message));

    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
    await sleep(2000);
    debugLog.push(`step3 done: ${page.url()}`);

    // ── STEP 4: Select contribuyente (always idContribuyente=0 = user's own CUIT) ──
    debugLog.push('step4: selecting contribuyente...');
    await page.goto('https://fes.afip.gob.ar/mcmp/jsp/setearContribuyente.do?idContribuyente=0', {
      waitUntil: 'networkidle2', timeout: 20000,
    }).catch(e => debugLog.push('step4 error: ' + e.message));
    await sleep(2000);
    debugLog.push(`step4 done: ${page.url()}`);

    // ── STEP 5: Navigate to Comprobantes Recibidos ──
    const curUrl = page.url();
    if (!/comprobantesRecibidos/i.test(curUrl)) {
      debugLog.push('step5: navigating to recibidos...');
      await page.goto('https://fes.afip.gob.ar/mcmp/jsp/comprobantesRecibidos.do', {
        waitUntil: 'networkidle2', timeout: 20000,
      }).catch(e => debugLog.push('step5 error: ' + e.message));
      await sleep(2000);
      debugLog.push(`step5 done: ${page.url()}`);
    } else {
      debugLog.push('step5: already on recibidos');
    }

    // Check for errors
    const bodyCheck = await page.evaluate(() => document.body?.innerText?.slice(0, 300) || '').catch(() => '');
    if (/sesi[oó]n.*expir/i.test(bodyCheck) || /no est[aá] logueado/i.test(bodyCheck)) {
      debugLog.push('ERROR: session expired');
      const shot = await debugShot(page).catch(() => null);
      return res.json({ ok: false, error: 'session_expired', msg: 'Sesión expiró.', debugLog, shot });
    }
    debugLog.push(`ready to parse: ${page.url()}`);

    // ── STEP 4: Wait for DataTables to render ──
    await page.waitForSelector('table, .dataTables_wrapper, #tablaComprobantes', { timeout: 15000 }).catch(() => {});
    await sleep(2000);

    // ── STEP 5: Parse the DataTables table ──
    // Headers: Fecha | Tipo | Número | Denominación Emisor | Imp. Total
    const parsed = await page.evaluate(() => {
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
      return { rows: results, tableCount: tables.length, headers: tables.length > 0 ? Array.from(tables[0].querySelectorAll('thead th')).map(t => t.textContent.trim()) : [] };
    }).catch(() => ({ rows: [], tableCount: 0, headers: [] }));

    debugLog.push(`tables found: ${parsed.tableCount}, headers: [${parsed.headers.join(', ')}], rows: ${parsed.rows.length}`);
    console.log(`[comprobantes] parsed ${parsed.rows.length} rows from ${parsed.tableCount} tables`);

    // ── STEP 6: Handle pagination (DataTables "Next" button) ──
    const allRows = [...parsed.rows];
    if (allRows.length > 0) {
      let pageNum = 2;
      while (pageNum <= 10) {
        const hasNext = await page.evaluate(() => {
          const next = document.querySelector('.paginate_button.next:not(.disabled), .next:not(.disabled) a, a.paginate_button.next:not(.disabled)');
          if (next) { next.click(); return true; }
          return false;
        }).catch(() => false);
        if (!hasNext) break;
        await sleep(2000);

        const moreRows = await page.evaluate(() => {
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
        allRows.push(...moreRows);
        debugLog.push(`page ${pageNum}: +${moreRows.length}`);
        pageNum++;
      }
    }

    // Debug info
    const bodyPreview = await page.evaluate(() => document.body?.innerText?.slice(0, 2000) || '').catch(() => '');
    const lastShot = await debugShot(page);
    const finalUrl = page.url();
    const finalTitle = await page.title().catch(() => '');

    // Normalize
    const normalized = allRows.map((c, idx) => ({
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
    const shot = await debugShot(page).catch(() => null);
    res.json({ ok: false, error: 'error_portal', msg: err.message, debugLog, shot });
  }
});

app.listen(PORT, () => console.log(`[deduxi-backend] listening on :${PORT}`));
