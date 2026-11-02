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
let desiredCast = { enabled: false, quality: 60 };
let suppressPageSwitchCount = 0;
const internalPages = new WeakSet();
let lastFrame = null;
let emittedFrameVersion = 0;
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
    if (suppressPageSwitchCount > 0 || internalPages.has(nextPage)) {
      internalPages.add(nextPage);
      return;
    }
    if (nextPage !== page) void switchPage(nextPage);
  });
  return page;
}

async function switchPage(nextPage) {
  if (nextPage === page || internalPages.has(nextPage)) return;
  const resumeCast = desiredCast.enabled;
  const resumeQuality = desiredCast.quality;
  await stopCast({ preserveDesired: true });
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
    const remaining = context.pages().filter((candidate) => !internalPages.has(candidate));
    const fallback = remaining[remaining.length - 1];
    if (fallback) void switchPage(fallback);
    else {
      page = null;
      lastFrame = null;
      elementMap = new Map();
    }
  });
  emit("page", { url: page.url(), title: await page.title().catch(() => "") });
  if (resumeCast) await startCast(resumeQuality);
}

async function getCdp() {
  if (!cdp) cdp = await page.context().newCDPSession(page);
  return cdp;
}

async function maskSensitiveFields() {
  if (page) await page.addStyleTag({ content: SENSITIVE_MASK_STYLE }).catch(() => {});
}

async function startCast(quality = 60) {
  const clampedQuality = Math.max(20, Math.min(90, Number(quality) || 60));
  desiredCast = { enabled: true, quality: clampedQuality };
  if (page) emit("page", { url: page.url(), title: await page.title().catch(() => "") });
  if (casting) {
    if (lastFrame) emit("frame", lastFrame);
    else {
      const frame = await getCdp().then((session) => session.send("Page.captureScreenshot", { format: "jpeg", quality: clampedQuality })).catch(() => null);
      if (frame?.data) {
        lastFrame = { data: frame.data, metadata: { timestamp: Date.now() / 1000, deviceWidth: VIEWPORT.width, deviceHeight: VIEWPORT.height } };
        emit("frame", lastFrame);
      }
    }
    return;
  }
  await maskSensitiveFields();
  const session = await getCdp();
  session.on("Page.screencastFrame", async ({ data, metadata, sessionId }) => {
    lastFrame = { data, metadata };
    emittedFrameVersion++;
    emit("frame", lastFrame);
    try { await session.send("Page.screencastFrameAck", { sessionId }); } catch {}
  });
  await session.send("Page.startScreencast", {
    format: "jpeg",
    quality: clampedQuality,
    maxWidth: VIEWPORT.width,
    maxHeight: VIEWPORT.height,
    everyNthFrame: 1,
  });
  casting = true;
  const initial = await session.send("Page.captureScreenshot", { format: "jpeg", quality: clampedQuality }).catch(() => null);
  if (initial?.data) {
    lastFrame = { data: initial.data, metadata: { timestamp: Date.now() / 1000, deviceWidth: VIEWPORT.width, deviceHeight: VIEWPORT.height } };
    emit("frame", lastFrame);
  }
}

async function stopCast({ preserveDesired = false } = {}) {
  if (!preserveDesired) desiredCast = { enabled: false, quality: desiredCast.quality };
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

function flowLocator(target, targetPage = page) {
  if (typeof target === "string") {
    const value = target.trim();
    if (!value) throw new Error("target selector cannot be empty");
    if (/^(?:#|\.|\[)/.test(value)) return targetPage.locator(value);
    const role = value.match(/^role=(\w+)(?:\[name=(.+)\])?$/i);
    if (role) return targetPage.getByRole(role[1], { name: (role[2] || "").replace(/^['\"]|['\"]$/g, "") });
    return targetPage.getByText(value, { exact: true });
  }
  if (target?.css) return targetPage.locator(String(target.css));
  if (target?.label) return targetPage.getByLabel(String(target.label), { exact: target.exact === true });
  if (target?.text) return targetPage.getByText(String(target.text), { exact: target.exact === true });
  if (target?.role) return targetPage.getByRole(String(target.role), {
    name: String(target.name ?? ""),
    exact: target.exact === true,
  });
  throw new Error("target requires role/name, label, text, or css");
}

function checkUrl(rawUrl, baseUrl) {
  const url = new URL(String(rawUrl), baseUrl);
  const base = new URL(baseUrl);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.port !== base.port) {
    throw new Error(`blocked url ${url.href}`);
  }
  return url.href;
}

function normalizeFlowTarget(raw) {
  if (typeof raw === "string") return raw.trim() || undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const source = raw.target && typeof raw.target === "object" && !Array.isArray(raw.target) ? raw.target : raw;
  const result = {};
  if (typeof source.role === "string") { result.role = source.role; result.name = String(source.name ?? source.text ?? source.label ?? ""); }
  if (typeof source.label === "string") result.label = source.label;
  if (typeof source.text === "string") result.text = source.text;
  if (typeof source.css === "string") result.css = source.css;
  else if (typeof source.selector === "string") result.css = source.selector;
  if (source.exact === true) result.exact = true;
  return Object.keys(result).length ? result : undefined;
}

function normalizeFlowStep(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const step = raw;
  if (typeof step.goto === "string" || typeof step.navigate === "string" || typeof step.url === "string") return { goto: String(step.goto ?? step.navigate ?? step.url) };
  const action = String(step.action ?? step.type ?? "").toLowerCase().replaceAll("_", "");
  if (["navigate", "goto", "open"].includes(action)) return { goto: String(step.path ?? step.url ?? step.value ?? step.target ?? "/") };
  if (action === "click" || "click" in step) {
    const target = normalizeFlowTarget(step.click ?? step.target ?? step.selector ?? step.css ?? step);
    return target === undefined ? undefined : { click: target };
  }
  if (["fill", "type", "input"].includes(action) || "fill" in step) {
    const target = normalizeFlowTarget(step.fill ?? step.target ?? step.selector ?? step.css ?? step);
    return target === undefined ? undefined : { fill: target, value: String(step.value ?? step.textValue ?? step.input ?? "") };
  }
  if (action === "press" || "press" in step) return { press: String(step.press ?? step.key ?? step.value ?? "Enter") };
  if (["wait", "sleep"].includes(action) || "wait" in step || "waitMs" in step) return { waitMs: Number(step.ms ?? step.timeout ?? step.waitMs ?? step.value ?? step.wait ?? 500) };
  if (["expecthidden", "asserthidden"].includes(action) || "expectHidden" in step) {
    const target = normalizeFlowTarget(step.expectHidden ?? step.target ?? step.selector ?? step.css ?? step.text ?? step.value);
    return target === undefined ? undefined : { expectHidden: target };
  }
  if (["expecturl", "asserturl"].includes(action) || "expectUrl" in step) return { expectUrl: String(step.expectUrl ?? step.url ?? step.value ?? step.target ?? "") };
  if (["expectvisible", "assertvisible", "asserttext", "expecttext", "assert", "verify"].includes(action) || "expectVisible" in step || "expectText" in step) {
    const textAssert = ["asserttext", "expecttext"].includes(action) || "expectText" in step;
    const target = normalizeFlowTarget(step.expectText ?? step.expectVisible ?? step.target ?? step.selector ?? step.css ?? step.text ?? step.value);
    if (target === undefined) return undefined;
    if (textAssert) return { expectText: target, ...(typeof step.equals === "string" ? { equals: step.equals } : {}), ...(typeof step.contains === "string" ? { contains: step.contains } : typeof step.text === "string" ? { contains: step.text } : {}) };
    return { expectVisible: target, ...(typeof step.timeoutMs === "number" ? { timeoutMs: step.timeoutMs } : {}) };
  }
  if (typeof step.wait === "number") return { waitMs: step.wait };
  return undefined;
}

async function runFlow(payload) {
  const activePage = await ensurePage();
  const rawSteps = Array.isArray(payload.steps) ? payload.steps : [];
  const steps = rawSteps.map(normalizeFlowStep);
  const port = Number(payload.port);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("run_flow requires a valid preview port");
  if (steps.length < 1 || steps.length > 30) throw new Error("run_flow supports 1 to 30 steps");
  const baseUrl = `http://127.0.0.1:${port}/`;
  let checkPage;
  suppressPageSwitchCount++;
  try {
    checkPage = await activePage.context().newPage();
    internalPages.add(checkPage);
  } finally {
    suppressPageSwitchCount--;
  }
  const errors = [];
  const failedRequests = [];
  const log = [];
  const failOnConsoleErrors = payload.failOnConsoleErrors !== false;
  await checkPage.route("**/*", async (route) => {
    try {
      checkUrl(route.request().url(), baseUrl);
      await route.continue();
    } catch {
      failedRequests.push(`blocked ${route.request().method()} ${route.request().url()}`);
      await route.abort("blockedbyclient").catch(() => {});
    }
  });
  checkPage.on("console", (msg) => {
    if (failOnConsoleErrors && msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
  });
  checkPage.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  checkPage.on("requestfailed", (request) => {
    const url = request.url();
    if (!/\/favicon\.ico(?:\?|$)/i.test(url)) failedRequests.push(`${request.method()} ${url}: ${request.failure()?.errorText ?? "failed"}`);
  });
  checkPage.on("response", (response) => {
    if (response.status() >= 500) failedRequests.push(`${response.request().method()} ${response.url()} -> ${response.status()}`);
  });
  const record = (index, step, result) => log.push({ step: index + 1, action: Object.keys(step)[0], result });
  const evidenceText = async () => (await checkPage.locator("body").innerText().catch(() => ""))
    .replace(/\s+/g, " ").trim().slice(0, 3_000);
  let failedStep = -1;
  let failedStepValue;
  let error = "";
  try {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      failedStep = i;
      failedStepValue = step;
      if (!step || typeof step !== "object") throw new Error("unsupported flow step");
      if ("goto" in step) {
        const url = checkUrl(step.goto, baseUrl);
        const response = await checkPage.goto(url, { waitUntil: "load", timeout: 15_000 });
        if (!response) throw new Error(`goto failed: ${url}`);
        if (response.status() >= 500) failedRequests.push(`GET ${url} -> ${response.status()}`);
        record(i, step, { url: checkPage.url(), status: response.status() });
      } else if ("click" in step) {
        await flowLocator(step.click, checkPage).first().click({ timeout: 5_000 });
        record(i, step, "clicked");
      } else if ("fill" in step) {
        await flowLocator(step.fill, checkPage).first().fill(String(step.value ?? ""), { timeout: 5_000 });
        record(i, step, "filled");
      } else if ("press" in step) {
        await checkPage.keyboard.press(String(step.press));
        record(i, step, "pressed");
      } else if ("expectVisible" in step) {
        await flowLocator(step.expectVisible, checkPage).first().waitFor({ state: "visible", timeout: Math.min(5_000, Math.max(1, Number(step.timeoutMs) || 5_000)) });
        record(i, step, "visible");
      } else if ("expectHidden" in step) {
        await flowLocator(step.expectHidden, checkPage).first().waitFor({ state: "hidden", timeout: Math.min(5_000, Math.max(1, Number(step.timeoutMs) || 5_000)) });
        record(i, step, "hidden");
      } else if ("expectUrl" in step) {
        const expected = checkUrl(step.expectUrl, baseUrl);
        await checkPage.waitForURL(expected, { timeout: 5_000 });
        record(i, step, { url: checkPage.url() });
      } else if ("expectText" in step) {
        const deadline = Date.now() + 5_000;
        let actual = "";
        let matched = false;
        do {
          actual = (await flowLocator(step.expectText, checkPage).first().innerText({ timeout: 1_000 }).catch(() => "")).trim();
          matched = (step.equals === undefined || actual === step.equals) &&
            (step.contains === undefined || actual.includes(step.contains)) &&
            (step.matches === undefined || new RegExp(step.matches).test(actual));
          if (!matched) await checkPage.waitForTimeout(100);
        } while (!matched && Date.now() < deadline);
        if (!matched) throw new Error(`expected text did not match; got "${actual.slice(0, 120)}"`);
        record(i, step, actual.slice(0, 300));
      } else if ("wait" in step || "waitMs" in step) {
        const waitMs = Number(step.waitMs ?? step.wait);
        if (!Number.isFinite(waitMs) || waitMs < 0 || waitMs > 5_000) throw new Error("wait must be between 0 and 5000 ms");
        await checkPage.waitForTimeout(waitMs);
        record(i, step, `waited ${waitMs} ms`);
      } else {
        throw new Error("unsupported flow step");
      }
      if (failOnConsoleErrors && errors.length) throw new Error(`page errors: ${errors.slice(0, 3).join(" | ")}`);
      if (failedRequests.length) throw new Error(`failed requests: ${failedRequests.slice(0, 3).join(" | ")}`);
    }
    return { passed: true, failedStep: -1, log, text: await evidenceText(), url: checkPage.url(), errors, failedRequests };
  } catch (cause) {
    error = cause instanceof Error ? cause.message : String(cause);
    const image = await checkPage.screenshot({ type: "jpeg", quality: 50 }).catch(() => null);
    return {
      passed: false,
      failedStep,
      step: failedStepValue,
      error,
      url: checkPage.url(),
      text: await evidenceText(),
      log: log.slice(-20),
      errors: errors.slice(-20),
      failedRequests: failedRequests.slice(-20),
      screenshotJpegBase64: image?.toString("base64") ?? null,
    };
  } finally {
    await checkPage.close().catch(() => {});
  }
}

async function dispatchInput(event) {
  const session = await getCdp();
  const clampX = (value) => Math.max(0, Math.min(VIEWPORT.width - 1, Math.round(Number(value) || 0)));
  const clampY = (value) => Math.max(0, Math.min(VIEWPORT.height - 1, Math.round(Number(value) || 0)));
  if (event.kind === "mouse") {
    return session.send("Input.dispatchMouseEvent", {
      type: event.type,
      x: clampX(event.x),
      y: clampY(event.y),
      button: event.button ?? "none",
      buttons: Number(event.buttons) || 0,
      clickCount: Number(event.clickCount) || 0,
      modifiers: Number(event.modifiers) || 0,
    });
  }
  if (event.kind === "wheel") {
    return session.send("Input.dispatchMouseEvent", {
      type: "mouseWheel", x: clampX(event.x), y: clampY(event.y),
      deltaX: Number(event.deltaX) || 0, deltaY: Number(event.deltaY) || 0,
      modifiers: Number(event.modifiers) || 0,
    });
  }
  if (event.kind === "scrollTo") {
    await page.evaluate((y) => window.scrollTo({ top: Number(y) || 0, behavior: "instant" }), event.y);
    return;
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
    if (action === "run_flow") {
      const port = Number(payload.port);
      const steps = Array.isArray(payload.steps) ? payload.steps : [];
      if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 8080) return { id, status: 400, body: { error: "run_flow requires a valid preview port" } };
      if (steps.length < 1 || steps.length > 30) return { id, status: 400, body: { error: "run_flow supports 1 to 30 steps" } };
      const result = await runFlow(payload);
      return { id, status: 200, body: result };
    }
    if (action === "input") {
      await ensurePage();
      const frameVersion = emittedFrameVersion;
      await dispatchInput(payload);
      if (casting) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        if (frameVersion === emittedFrameVersion) {
          const session = await getCdp();
          const frame = await session.send("Page.captureScreenshot", { format: "jpeg", quality: 60 }).catch(() => null);
          if (frame?.data) {
            lastFrame = { data: frame.data, metadata: { timestamp: Date.now() / 1000, deviceWidth: VIEWPORT.width, deviceHeight: VIEWPORT.height } };
            emittedFrameVersion++;
            emit("frame", lastFrame);
          }
        }
      }
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
    if (action === "visual_regions") {
      const regions = await activePage.evaluate(() => Array.from(document.querySelectorAll("button,input,textarea,select,a,[role=button],[role=link]"))
        .slice(0, 100).map((element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          if (rect.width < 2 || rect.height < 2 || style.visibility === "hidden" || style.display === "none") return null;
          const label = element.getAttribute("aria-label") || element.getAttribute("title") || element.innerText || element.getAttribute("placeholder") || element.tagName.toLowerCase();
          return { label: String(label).replace(/\\s+/g, " ").trim().slice(0, 60), x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        }).filter(Boolean));
      return { id, status: 200, body: { width: activePage.viewportSize()?.width ?? VIEWPORT.width, height: activePage.viewportSize()?.height ?? VIEWPORT.height, regions } };
    }
    if (action === "observe") {
      const observed = await snapshot();
      await maskSensitiveFields();
      const image = await activePage.screenshot({ type: "jpeg", quality: 50, scale: "css" }).catch(() => null);
      const text = (await activePage.locator("body").innerText().catch(() => ""))
        .replace(/\s+/g, " ").trim().slice(0, 3_000);
      return { id, status: 200, body: { ...observed, text, screenshotJpegBase64: image?.toString("base64") ?? null } };
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
    const message = JSON.parse(line);
    const response = await handleCommand(message);
    if (response) {
      const safeResponse = response && typeof response === "object" && response.id !== undefined && Number.isInteger(response.status) && response.body && typeof response.body === "object"
        ? response
        : { id: message.id, status: 200, body: response ?? {} };
      process.stdout.write(`${JSON.stringify(safeResponse)}\n`);
    }
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  }
});
process.on("SIGTERM", async () => {
  await stopCast();
  if (browser) await browser.close().catch(() => {});
  process.exit(0);
});
