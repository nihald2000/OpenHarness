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
let elementMetaMap = new Map();
let lastCursor = { x: 640, y: 400, action: "idle", label: "", timestamp: 0 };

const emit = (event, data) => process.stdout.write(`${JSON.stringify({ event, ...data })}\n`);
const appendBounded = (array, value) => {
  array.push(value);
  if (array.length > MAX_LOGS) array.splice(0, array.length - MAX_LOGS);
};

function isAllowedNavigation(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl));
    if (parsed.href === "about:blank") return true;
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    const host = parsed.hostname.toLowerCase();
    if (host === "169.254.169.254" || host === "metadata.google.internal" || host.startsWith("169.254.")) return false;
    if ((host === "127.0.0.1" || host === "localhost") && parsed.port === "8080") return false;
    return true;
  } catch {
    return false;
  }
}

function normalizeRefId(rawRef) {
  const s = String(rawRef ?? "").trim();
  if (!s) return "";
  const bracketMatch = s.match(/\[ref=([^\]]+)\]/i);
  if (bracketMatch) return bracketMatch[1].replace(/^@/, "");
  const colonMatch = s.match(/^@?[a-z0-9_]+:(e\d+)$/i);
  if (colonMatch) return colonMatch[1].toLowerCase();
  if (/^@?e\d+$/i.test(s)) return s.replace(/^@/, "").toLowerCase();
  return s;
}

async function moveAiCursorOnPage(targetPage, x, y, action = "move", label = "") {
  const clampedX = Math.max(4, Math.min(VIEWPORT.width - 4, Math.round(Number(x) || 640)));
  const clampedY = Math.max(4, Math.min(VIEWPORT.height - 4, Math.round(Number(y) || 400)));
  lastCursor = {
    x: clampedX,
    y: clampedY,
    action: String(action || "move"),
    label: String(label || "").slice(0, 60),
    timestamp: Date.now(),
  };
  emit("cursor", lastCursor);
  try {
    await targetPage.mouse.move(clampedX, clampedY, { steps: 4 });
  } catch {}
}

async function emitFreshCastFrame(targetPage = page) {
  if (!targetPage) return null;
  try {
    await maskSensitiveFields();
    const buf = await targetPage.screenshot({ type: "jpeg", quality: 58, scale: "css" }).catch(() => null);
    if (!buf) return null;
    const base64 = buf.toString("base64");
    lastFrame = {
      data: base64,
      metadata: {
        timestamp: Date.now() / 1000,
        deviceWidth: VIEWPORT.width,
        deviceHeight: VIEWPORT.height,
        cursor: lastCursor,
      },
    };
    emittedFrameVersion++;
    emit("frame", lastFrame);
    return base64;
  } catch {
    return null;
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
  elementMetaMap = new Map();
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
      elementMetaMap = new Map();
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
        lastFrame = { data: frame.data, metadata: { timestamp: Date.now() / 1000, deviceWidth: VIEWPORT.width, deviceHeight: VIEWPORT.height, cursor: lastCursor } };
        emit("frame", lastFrame);
      }
    }
    return;
  }
  await maskSensitiveFields();
  const session = await getCdp();
  session.on("Page.screencastFrame", async ({ data, metadata, sessionId }) => {
    lastFrame = { data, metadata: { ...metadata, cursor: lastCursor } };
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
    lastFrame = { data: initial.data, metadata: { timestamp: Date.now() / 1000, deviceWidth: VIEWPORT.width, deviceHeight: VIEWPORT.height, cursor: lastCursor } };
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
  const title = await page.title().catch(() => "");
  const url = page.url();
  const handles = await page.$$("button, a, input, textarea, select, [role='button'], [role='link'], [role='checkbox'], [role='radio'], [role='tab'], h1, h2, h3");
  elementMap = new Map();
  elementMetaMap = new Map();
  const elements = [];
  for (let i = 0; i < Math.min(handles.length, 100); i++) {
    const ref = `e${i + 1}`;
    const handle = handles[i];
    const info = await handle.evaluate((el, args) => {
      const { autocompletePattern, assignedRef } = args;
      el.setAttribute("data-oh-ref", assignedRef);
      const type = (el.getAttribute("type") || "").toLowerCase();
      const autocomplete = el.getAttribute("autocomplete") || "";
      const sensitive = type === "password" || new RegExp(autocompletePattern, "i").test(autocomplete);
      const hasValue = "value" in el && Boolean(el.value);
      const rect = el.getBoundingClientRect();
      return {
        role: el.getAttribute("role") || el.tagName.toLowerCase(),
        tagName: el.tagName.toLowerCase(),
        id: el.id || "",
        placeholder: el.getAttribute("placeholder") || "",
        name: (
          el.getAttribute("aria-label") ||
          el.innerText ||
          el.textContent ||
          el.getAttribute("placeholder") ||
          el.getAttribute("name") ||
          el.value ||
          ""
        ).replace(/\s+/g, " ").trim().slice(0, 80),
        value: "value" in el ? (sensitive ? (hasValue ? "••••" : "") : String(el.value || "")) : undefined,
        x: Math.round(rect.left + rect.width / 2),
        y: Math.round(rect.top + rect.height / 2),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    }, { autocompletePattern: SENSITIVE_AUTOCOMPLETE.source, assignedRef: ref }).catch(() => null);
    if (!info) continue;
    elementMap.set(ref, handle);
    elementMetaMap.set(ref, info);
    elements.push({
      ref,
      role: info.role,
      name: info.name,
      ...(info.value !== undefined ? { value: info.value } : {}),
      x: info.x,
      y: info.y,
    });
  }
  const snapshotText = [
    `- document [title="${title}" url="${url}"]`,
    ...elements.map((el) => `  - ${el.role} "${el.name}" [ref=${el.ref}]${el.value ? ` value="${el.value}"` : ""} (x=${el.x},y=${el.y})`),
  ].join("\n").slice(0, 8_000);
  return { url, title, snapshot: snapshotText, elements };
}

async function resolveInteractiveElement(activePage, payload) {
  const rawRef = normalizeRefId(payload.ref ?? payload.target ?? payload.selector ?? "");
  if (elementMap.size === 0 && rawRef) {
    await snapshot().catch(() => {});
  }
  // 1. Check live handle in elementMap if still connected to DOM
  if (rawRef && elementMap.has(rawRef)) {
    const candidate = elementMap.get(rawRef);
    const connected = await candidate.evaluate((el) => Boolean(el && el.isConnected)).catch(() => false);
    if (connected) {
      const box = await candidate.boundingBox().catch(() => null);
      const meta = elementMetaMap.get(rawRef);
      return {
        handle: candidate,
        ref: rawRef,
        label: meta?.name || rawRef,
        x: box ? Math.round(box.x + box.width / 2) : meta?.x ?? 640,
        y: box ? Math.round(box.y + box.height / 2) : meta?.y ?? 400,
      };
    }
  }
  // 2. Re-query by data-oh-ref attribute or stored metadata if DOM re-rendered
  if (rawRef) {
    const byDataAttr = await activePage.$(`[data-oh-ref="${rawRef}"]`).catch(() => null);
    if (byDataAttr) {
      const box = await byDataAttr.boundingBox().catch(() => null);
      const meta = elementMetaMap.get(rawRef);
      return {
        handle: byDataAttr,
        ref: rawRef,
        label: meta?.name || rawRef,
        x: box ? Math.round(box.x + box.width / 2) : meta?.x ?? 640,
        y: box ? Math.round(box.y + box.height / 2) : meta?.y ?? 400,
      };
    }
    const meta = elementMetaMap.get(rawRef);
    if (meta) {
      let loc = null;
      if (meta.id) {
        loc = activePage.locator(`#${CSS.escape(meta.id)}`).first();
      } else if (meta.placeholder) {
        loc = activePage.getByPlaceholder(meta.placeholder).first();
      } else if (meta.name && ["button", "a", "link"].includes(meta.role)) {
        loc = activePage.getByRole(meta.role === "a" ? "link" : "button", { name: meta.name }).first();
      } else if (meta.name) {
        loc = activePage.getByText(meta.name, { exact: false }).first();
      }
      if (loc && (await loc.count().catch(() => 0)) > 0) {
        const handle = await loc.elementHandle().catch(() => null);
        if (handle) {
          const box = await handle.boundingBox().catch(() => null);
          return {
            handle,
            ref: rawRef,
            label: meta.name || rawRef,
            x: box ? Math.round(box.x + box.width / 2) : meta.x ?? 640,
            y: box ? Math.round(box.y + box.height / 2) : meta.y ?? 400,
          };
        }
      }
    }
  }
  // 3. Fallback: selector, text, or role lookup if model passed text/selector instead of eN
  const queryText = String(payload.text_target ?? payload.label ?? (!/^e\d+$/i.test(rawRef) ? rawRef : "")).trim();
  const cssSelector = String(payload.selector ?? payload.css ?? "").trim();
  if (cssSelector) {
    const handle = await activePage.$(cssSelector).catch(() => null);
    if (handle) {
      const box = await handle.boundingBox().catch(() => null);
      return {
        handle,
        ref: cssSelector,
        label: cssSelector,
        x: box ? Math.round(box.x + box.width / 2) : 640,
        y: box ? Math.round(box.y + box.height / 2) : 400,
      };
    }
  }
  if (queryText) {
    const byRoleBtn = activePage.getByRole("button", { name: queryText }).first();
    if ((await byRoleBtn.count().catch(() => 0)) > 0) {
      const handle = await byRoleBtn.elementHandle().catch(() => null);
      if (handle) {
        const box = await handle.boundingBox().catch(() => null);
        return {
          handle,
          ref: queryText,
          label: queryText,
          x: box ? Math.round(box.x + box.width / 2) : 640,
          y: box ? Math.round(box.y + box.height / 2) : 400,
        };
      }
    }
    const byText = activePage.getByText(queryText, { exact: false }).first();
    if ((await byText.count().catch(() => 0)) > 0) {
      const handle = await byText.elementHandle().catch(() => null);
      if (handle) {
        const box = await handle.boundingBox().catch(() => null);
        return {
          handle,
          ref: queryText,
          label: queryText,
          x: box ? Math.round(box.x + box.width / 2) : 640,
          y: box ? Math.round(box.y + box.height / 2) : 400,
        };
      }
    }
  }
  return null;
}

function flowLocator(target, targetPage = page) {
  if (typeof target === "string") {
    const value = target.trim();
    if (!value) throw new Error("target selector cannot be empty");
    if (/^@?e\d+$/i.test(value)) {
      const cleanRef = value.replace(/^@/, "").toLowerCase();
      return targetPage.locator(`[data-oh-ref="${cleanRef}"]`);
    }
    if (/^(?:#|\.|\[)/.test(value)) return targetPage.locator(value);
    const role = value.match(/^role=(\w+)(?:\[name=(.+)\])?$/i);
    if (role) return targetPage.getByRole(role[1], { name: (role[2] || "").replace(/^['\"]|['\"]$/g, "") });
    return targetPage.getByText(value, { exact: false });
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
        const loc = flowLocator(step.click, checkPage).first();
        const box = await loc.boundingBox().catch(() => null);
        if (box) await moveAiCursorOnPage(checkPage, box.x + box.width / 2, box.y + box.height / 2, "click", `Click · ${typeof step.click === "string" ? step.click : (step.click?.name || step.click?.text || "element")}`);
        await loc.click({ timeout: 5_000 });
        record(i, step, "clicked");
      } else if ("fill" in step) {
        const loc = flowLocator(step.fill, checkPage).first();
        const box = await loc.boundingBox().catch(() => null);
        if (box) await moveAiCursorOnPage(checkPage, box.x + box.width / 2, box.y + box.height / 2, "type", `Type · ${String(step.value ?? "").slice(0, 24)}`);
        await loc.fill(String(step.value ?? ""), { timeout: 5_000 });
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
    await snapshot().catch(() => {});
    const screenshotJpegBase64 = await emitFreshCastFrame(checkPage);
    return { passed: true, failedStep: -1, log, text: await evidenceText(), url: checkPage.url(), errors, failedRequests, cursor: lastCursor, screenshotJpegBase64 };
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
    let activePage;
    try {
      activePage = await ensurePage();
    } catch (launchErr) {
      return {
        id,
        status: 503,
        body: { error: `Playwright browser worker unavailable: ${launchErr instanceof Error ? launchErr.message : String(launchErr)}` },
      };
    }

    if (action === "input") {
      const frameVersion = emittedFrameVersion;
      await dispatchInput(payload);
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (frameVersion === emittedFrameVersion) {
        await emitFreshCastFrame(activePage);
      }
      return id ? { id, status: 200, body: { ok: true, cursor: lastCursor } } : null;
    }

    if (action === "navigate") {
      const target = String(payload.url ?? "");
      if (!isAllowedNavigation(target)) return { id, status: 400, body: { error: "Only http(s) URLs are allowed" } };
      if (new URL(target).href === "about:blank") await activePage.goto("about:blank");
      else await activePage.goto(target, { waitUntil: "domcontentloaded", timeout: 15_000 });
      await moveAiCursorOnPage(activePage, 640, 360, "navigate", `Open · ${new URL(target).pathname || "/"}`);
      const snap = await snapshot();
      const screenshotJpegBase64 = await emitFreshCastFrame(checkPage);
      return {
        id,
        status: 200,
        body: {
          url: activePage.url(),
          title: snap.title,
          snapshot: snap.snapshot,
          elements: snap.elements,
          cursor: lastCursor,
          screenshotJpegBase64,
        },
      };
    }

    if (action === "snapshot") {
      const snap = await snapshot();
      const screenshotJpegBase64 = await emitFreshCastFrame(checkPage);
      return { id, status: 200, body: { ...snap, cursor: lastCursor, screenshotJpegBase64 } };
    }

    if (action === "visual_regions") {
      const regions = await activePage.evaluate(() => Array.from(document.querySelectorAll("button,input,textarea,select,a,[role=button],[role=link]"))
        .slice(0, 100).map((element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          if (rect.width < 2 || rect.height < 2 || style.visibility === "hidden" || style.display === "none") return null;
          const label = element.getAttribute("aria-label") || element.getAttribute("title") || element.innerText || element.getAttribute("placeholder") || element.tagName.toLowerCase();
          return { label: String(label).replace(/\s+/g, " ").trim().slice(0, 60), x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        }).filter(Boolean));
      return { id, status: 200, body: { width: activePage.viewportSize()?.width ?? VIEWPORT.width, height: activePage.viewportSize()?.height ?? VIEWPORT.height, regions } };
    }

    if (action === "observe") {
      const observed = await snapshot();
      await maskSensitiveFields();
      const image = await activePage.screenshot({ type: "jpeg", quality: 50, scale: "css" }).catch(() => null);
      const text = (await activePage.locator("body").innerText().catch(() => ""))
        .replace(/\s+/g, " ").trim().slice(0, 3_000);
      return { id, status: 200, body: { ...observed, text, cursor: lastCursor, screenshotJpegBase64: image?.toString("base64") ?? null } };
    }

    if (action === "click") {
      // Support coordinate-based cursor click { x, y } OR ref/selector/text click
      if (typeof payload.x === "number" && typeof payload.y === "number" && !payload.ref) {
        const cx = Math.max(0, Math.min(VIEWPORT.width - 1, Math.round(payload.x)));
        const cy = Math.max(0, Math.min(VIEWPORT.height - 1, Math.round(payload.y)));
        await moveAiCursorOnPage(activePage, cx, cy, "click", `Click · (${cx}, ${cy})`);
        await activePage.mouse.click(cx, cy, { clickCount: payload.doubleClick ? 2 : 1 });
        await activePage.waitForTimeout(120);
        const snap = await snapshot();
        const screenshotJpegBase64 = await emitFreshCastFrame(checkPage);
        return {
          id,
          status: 200,
          body: {
            clicked: `(${cx},${cy})`,
            cursor: lastCursor,
            url: snap.url,
            title: snap.title,
            snapshot: snap.snapshot,
            elements: snap.elements,
            screenshotJpegBase64,
          },
        };
      }
      const resolved = await resolveInteractiveElement(activePage, payload);
      if (!resolved) {
        const fresh = await snapshot();
        return {
          id,
          status: 400,
          body: {
            error: `Element handle [${String(payload.ref ?? payload.selector ?? "")}] not found on current page. Use one of the updated [ref=eN] handles in snapshot.`,
            url: fresh.url,
            title: fresh.title,
            snapshot: fresh.snapshot,
            elements: fresh.elements,
          },
        };
      }
      await moveAiCursorOnPage(activePage, resolved.x, resolved.y, "click", `Click · ${resolved.label}`);
      try {
        await resolved.handle.click({ timeout: 4_000 });
      } catch {
        await activePage.mouse.click(resolved.x, resolved.y);
      }
      await activePage.waitForTimeout(120);
      const snap = await snapshot();
      const screenshotJpegBase64 = await emitFreshCastFrame(checkPage);
      return {
        id,
        status: 200,
        body: {
          clicked: resolved.ref,
          label: resolved.label,
          cursor: lastCursor,
          url: snap.url,
          title: snap.title,
          snapshot: snap.snapshot,
          elements: snap.elements,
          screenshotJpegBase64,
        },
      };
    }

    if (action === "type") {
      const value = String(payload.text ?? "").slice(0, 10_000);
      if (typeof payload.x === "number" && typeof payload.y === "number" && !payload.ref) {
        const cx = Math.max(0, Math.min(VIEWPORT.width - 1, Math.round(payload.x)));
        const cy = Math.max(0, Math.min(VIEWPORT.height - 1, Math.round(payload.y)));
        await moveAiCursorOnPage(activePage, cx, cy, "type", `Type · ${value.slice(0, 24)}`);
        await activePage.mouse.click(cx, cy);
        await activePage.keyboard.type(value);
        if (payload.pressEnter) await activePage.keyboard.press("Enter");
        await activePage.waitForTimeout(120);
        const snap = await snapshot();
        const screenshotJpegBase64 = await emitFreshCastFrame(checkPage);
        return {
          id,
          status: 200,
          body: {
            typed: `(${cx},${cy})`,
            cursor: lastCursor,
            url: snap.url,
            title: snap.title,
            snapshot: snap.snapshot,
            elements: snap.elements,
            screenshotJpegBase64,
          },
        };
      }
      const resolved = await resolveInteractiveElement(activePage, payload);
      if (!resolved) {
        const fresh = await snapshot();
        return {
          id,
          status: 400,
          body: {
            error: `Input element [${String(payload.ref ?? payload.selector ?? "")}] not found on current page. Use one of the updated [ref=eN] handles in snapshot.`,
            url: fresh.url,
            title: fresh.title,
            snapshot: fresh.snapshot,
            elements: fresh.elements,
          },
        };
      }
      const sensitive = await resolved.handle.evaluate((el, autocompletePattern) =>
        (el.getAttribute("type") || "").toLowerCase() === "password" || new RegExp(autocompletePattern, "i").test(el.getAttribute("autocomplete") || ""),
      SENSITIVE_AUTOCOMPLETE.source).catch(() => false);
      await moveAiCursorOnPage(activePage, resolved.x, resolved.y, "type", `Type · ${sensitive ? "••••" : value.slice(0, 24)}`);
      try {
        await resolved.handle.fill(value, { timeout: 4_000 });
      } catch {
        await activePage.mouse.click(resolved.x, resolved.y);
        await activePage.keyboard.type(value);
      }
      if (payload.pressEnter) await activePage.keyboard.press("Enter");
      await activePage.waitForTimeout(120);
      const snap = await snapshot();
      const screenshotJpegBase64 = await emitFreshCastFrame(checkPage);
      return {
        id,
        status: 200,
        body: {
          typed: resolved.ref,
          value: sensitive ? (value ? "••••" : "") : undefined,
          cursor: lastCursor,
          url: snap.url,
          title: snap.title,
          snapshot: snap.snapshot,
          elements: snap.elements,
          screenshotJpegBase64,
        },
      };
    }

    if (action === "press") {
      const key = String(payload.key ?? "Enter");
      await moveAiCursorOnPage(activePage, lastCursor.x, lastCursor.y, "press", `Key · ${key}`);
      await activePage.keyboard.press(key);
      await activePage.waitForTimeout(100);
      const snap = await snapshot();
      const screenshotJpegBase64 = await emitFreshCastFrame(checkPage);
      return {
        id,
        status: 200,
        body: {
          pressed: key,
          cursor: lastCursor,
          url: snap.url,
          title: snap.title,
          snapshot: snap.snapshot,
          elements: snap.elements,
          screenshotJpegBase64,
        },
      };
    }

    if (action === "screenshot") {
      await maskSensitiveFields();
      const buf = await activePage.screenshot({ type: "png" });
      return { id, status: 200, body: { mimeType: "image/png", url: activePage.url(), title: await activePage.title(), cursor: lastCursor, dataBase64: buf.toString("base64") } };
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
    const snap = page ? await snapshot().catch(() => null) : null;
    return {
      id,
      status: 400,
      body: {
        error: err instanceof Error ? err.message : String(err),
        ...(snap ? { url: snap.url, title: snap.title, snapshot: snap.snapshot, elements: snap.elements } : {}),
      },
    };
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
