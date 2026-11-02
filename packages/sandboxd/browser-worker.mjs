import readline from "node:readline";

const VIEWPORT = { width: 1280, height: 800 };
const SENSITIVE_AUTOCOMPLETE = /password|one-time-code|cc-/i;
const SENSITIVE_MASK_STYLE = `input[type="password"],input[autocomplete*="password" i],input[autocomplete*="one-time-code" i],input[autocomplete*="cc-" i],[name*="password" i] { color: transparent !important; text-shadow: none !important; caret-color: transparent !important; }`;
const MAX_LOGS = 200;
let browser = null;
let context = null;
let page = null;
let cdp = null;
let casting = false;
let lastFrame = null;
const consoleLogs = [];
const networkErrors = [];
let elementMap = new Map();

const emit = (event, data) => process.stdout.write(`${JSON.stringify({ event, ...data })}\n`);
const appendBounded = (array, value) => {
  array.push(value);
  if (array.length > MAX_LOGS) array.splice(0, array.length - MAX_LOGS);
};

function isAllowedNavigation(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl));
    return parsed.href === "about:blank" || parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

async function ensurePage() {
  if (page) return page;
  const pw = await import("playwright");
  browser = await pw.chromium.launch({
    ...(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH } : {}),
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
  });
  context = await browser.newContext({ viewport: VIEWPORT });
  await context.route("**/*", async (route) => {
    if (isAllowedNavigation(route.request().url())) return route.continue();
    return route.abort("blockedbyclient");
  });
  const firstPage = await context.newPage();
  await switchPage(firstPage);
  context.on("page", (nextPage) => {
    if (nextPage !== page) void switchPage(nextPage);
  });
  return page;
}

async function switchPage(nextPage) {
  if (nextPage === page) return;
  await stopCast();
  if (cdp) {
    try { await cdp.detach(); } catch {}
    cdp = null;
  }
  page = nextPage;
  lastFrame = null;
  elementMap = new Map();
  page.on("console", (msg) => appendBounded(consoleLogs, `[${msg.type()}] ${msg.text()}`));
  page.on("requestfailed", (req) => appendBounded(networkErrors, `${req.method()} ${req.url()}: ${req.failure()?.errorText ?? "failed"}`));
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) {
      void page.title().then((title) => emit("page", { url: page.url(), title })).catch(() => emit("page", { url: page.url(), title: "" }));
    }
  });
  page.on("close", () => {
    if (page !== nextPage || !context) return;
    const remaining = context.pages();
    const fallback = remaining[remaining.length - 1];
    if (fallback) void switchPage(fallback);
    else {
      page = null;
      lastFrame = null;
      elementMap = new Map();
    }
  });
  emit("page", { url: page.url(), title: await page.title().catch(() => "") });
}

async function getCdp() {
  if (!cdp) cdp = await page.context().newCDPSession(page);
  return cdp;
}

async function maskSensitiveFields() {
  if (page) await page.addStyleTag({ content: SENSITIVE_MASK_STYLE }).catch(() => {});
}

async function startCast(quality = 60) {
  if (casting) {
    if (lastFrame) emit("frame", lastFrame);
    return;
  }
  await maskSensitiveFields();
  const session = await getCdp();
  session.on("Page.screencastFrame", async ({ data, metadata, sessionId }) => {
    lastFrame = { data, metadata };
    emit("frame", lastFrame);
    try { await session.send("Page.screencastFrameAck", { sessionId }); } catch {}
  });
  await session.send("Page.startScreencast", {
    format: "jpeg",
    quality: Math.max(20, Math.min(90, Number(quality) || 60)),
    maxWidth: VIEWPORT.width,
    maxHeight: VIEWPORT.height,
    everyNthFrame: 1,
  });
  casting = true;
}

async function stopCast() {
  if (!casting) return;
  casting = false;
  try { await cdp?.send("Page.stopScreencast"); } catch {}
  try { await cdp?.detach(); } catch {}
  cdp = null;
}

async function snapshot() {
  const title = await page.title();
  const url = page.url();
  const handles = await page.$$("button, a, input, textarea, select, [role], h1, h2, h3");
  elementMap = new Map();
  const elements = [];
  for (let i = 0; i < Math.min(handles.length, 100); i++) {
    const ref = `e${i + 1}`;
    const handle = handles[i];
    const info = await handle.evaluate((el, autocompletePattern) => {
      const type = (el.getAttribute("type") || "").toLowerCase();
      const autocomplete = el.getAttribute("autocomplete") || "";
      const sensitive = type === "password" || new RegExp(autocompletePattern, "i").test(autocomplete);
      const hasValue = "value" in el && Boolean(el.value);
      return {
        role: el.getAttribute("role") || el.tagName.toLowerCase(),
        name: (el.textContent || el.getAttribute("aria-label") || el.getAttribute("name") || "").trim().slice(0, 80),
        value: "value" in el ? (sensitive ? (hasValue ? "••••" : "") : String(el.value || "")) : undefined,
      };
    }, SENSITIVE_AUTOCOMPLETE.source);
    elementMap.set(ref, handle);
    elements.push({ ref, ...info });
  }
  const snapshotText = [
    `- document [title="${title}" url="${url}"]`,
    ...elements.map((el) => `  - ${el.role} "${el.name}" [ref=${el.ref}]${el.value ? ` value="${el.value}"` : ""}`),
  ].join("\n").slice(0, 8_000);
  return { url, title, snapshot: snapshotText, elements };
}

async function dispatchInput(event) {
  const session = await getCdp();
  if (event.kind === "mouse") {
    return session.send("Input.dispatchMouseEvent", {
      type: event.type,
      x: Number(event.x) || 0,
      y: Number(event.y) || 0,
      button: event.button ?? "none",
      buttons: Number(event.buttons) || 0,
      clickCount: Number(event.clickCount) || 0,
      modifiers: Number(event.modifiers) || 0,
    });
  }
  if (event.kind === "wheel") {
    return session.send("Input.dispatchMouseEvent", {
      type: "mouseWheel", x: Number(event.x) || 0, y: Number(event.y) || 0,
      deltaX: Number(event.deltaX) || 0, deltaY: Number(event.deltaY) || 0,
    });
  }
  if (event.kind === "key") {
    return session.send("Input.dispatchKeyEvent", {
      type: event.type, key: event.key, code: event.code, text: event.text,
      unmodifiedText: event.text, windowsVirtualKeyCode: event.keyCode,
      modifiers: Number(event.modifiers) || 0,
    });
  }
  if (event.kind === "text") return session.send("Input.insertText", { text: String(event.text ?? "").slice(0, 10_000) });
}

async function handleCommand(command) {
  const { id, action, payload = {} } = command;
  try {
    if (action === "input") {
      await ensurePage();
      await dispatchInput(payload);
      return id ? { id, status: 200, body: { ok: true } } : null;
    }
    const activePage = await ensurePage();
    if (action === "navigate") {
      const target = String(payload.url ?? "");
      if (!isAllowedNavigation(target)) return { id, status: 400, body: { error: "Only http(s) URLs are allowed" } };
      if (new URL(target).href === "about:blank") await activePage.goto("about:blank");
      else await activePage.goto(target, { waitUntil: "domcontentloaded", timeout: 15_000 });
      return { id, status: 200, body: { url: activePage.url(), title: await activePage.title() } };
    }
    if (action === "snapshot") return { id, status: 200, body: await snapshot() };
    if (action === "observe") {
      const observed = await snapshot();
      await maskSensitiveFields();
      const image = await activePage.screenshot({ type: "jpeg", quality: 50, scale: "css" });
      return { id, status: 200, body: { ...observed, screenshotJpegBase64: image.toString("base64") } };
    }
    if (action === "click") {
      const ref = String(payload.ref ?? "");
      const handle = elementMap.get(ref);
      if (!handle) return { id, status: 400, body: { error: `Element handle [ref=${ref}] not found` } };
      await handle.click({ timeout: 5_000 });
      return { id, status: 200, body: { clicked: ref } };
    }
    if (action === "type") {
      const ref = String(payload.ref ?? "");
      const value = String(payload.text ?? "").slice(0, 10_000);
      const handle = elementMap.get(ref);
      if (!handle) return { id, status: 400, body: { error: `Element handle [ref=${ref}] not found` } };
      const sensitive = await handle.evaluate((el, autocompletePattern) =>
        (el.getAttribute("type") || "").toLowerCase() === "password" || new RegExp(autocompletePattern, "i").test(el.getAttribute("autocomplete") || ""),
      SENSITIVE_AUTOCOMPLETE.source);
      await handle.fill(value, { timeout: 5_000 });
      return { id, status: 200, body: { typed: ref, value: sensitive ? (value ? "••••" : "") : undefined } };
    }
    if (action === "press") {
      const key = String(payload.key ?? "Enter");
      await activePage.keyboard.press(key);
      return { id, status: 200, body: { pressed: key } };
    }
    if (action === "screenshot") {
      await maskSensitiveFields();
      const buf = await activePage.screenshot({ type: "png" });
      return { id, status: 200, body: { mimeType: "image/png", url: activePage.url(), title: await activePage.title(), dataBase64: buf.toString("base64") } };
    }
    if (action === "screencast_start") {
      await startCast(payload.quality);
      return { id, status: 200, body: { casting: true } };
    }
    if (action === "screencast_stop") {
      await stopCast();
      return { id, status: 200, body: { casting: false } };
    }
    if (action === "console_logs") return { id, status: 200, body: { logs: [...consoleLogs] } };
    if (action === "network_errors") return { id, status: 200, body: { errors: [...networkErrors] } };
    return { id, status: 404, body: { error: `Unknown browser action: ${action}` } };
  } catch (err) {
    return { id, status: 503, body: { error: `Playwright browser worker unavailable: ${err instanceof Error ? err.message : String(err)}` } };
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  try {
    const response = await handleCommand(JSON.parse(line));
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  }
});
process.on("SIGTERM", async () => {
  await stopCast();
  if (browser) await browser.close().catch(() => {});
  process.exit(0);
});
