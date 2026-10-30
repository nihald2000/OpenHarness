import readline from "node:readline";

let browser = null;
let page = null;
const consoleLogs = [];
const networkErrors = [];
let elementMap = new Map();

async function ensurePage() {
  if (page) return page;
  const pw = await import("playwright");
  browser = await pw.chromium.launch({ headless: true });
  const context = await browser.newContext();
  page = await context.newPage();
  page.on("console", (msg) => {
    consoleLogs.push(`[${msg.type()}] ${msg.text()}`);
  });
  page.on("requestfailed", (req) => {
    networkErrors.push(`${req.method()} ${req.url()}: ${req.failure()?.errorText ?? "failed"}`);
  });
  return page;
}

async function handleCommand(cmd) {
  const { id, action, payload = {} } = cmd;
  try {
    const p = await ensurePage();
    if (action === "navigate") {
      await p.goto(String(payload.url), { waitUntil: "domcontentloaded", timeout: 15_000 });
      const title = await p.title();
      return { id, status: 200, body: { url: p.url(), title } };
    }
    if (action === "snapshot") {
      const title = await p.title();
      const url = p.url();
      const handles = await p.$$("button, a, input, textarea, select, [role], h1, h2, h3");
      elementMap = new Map();
      const elements = [];
      for (let i = 0; i < Math.min(handles.length, 100); i++) {
        const ref = `e${i + 1}`;
        const h = handles[i];
        const info = await h.evaluate((el) => ({
          role: el.getAttribute("role") || el.tagName.toLowerCase(),
          name: (el.textContent || el.getAttribute("aria-label") || el.getAttribute("name") || "").trim().slice(0, 80),
          value: "value" in el ? String(el.value || "") : undefined,
        }));
        elementMap.set(ref, h);
        elements.push({ ref, ...info });
      }
      const treeLines = [
        `- document [title="${title}" url="${url}"]`,
        ...elements.map(
          (el) =>
            `  - ${el.role} "${el.name}" [ref=${el.ref}]${el.value ? ` value="${el.value}"` : ""}`
        ),
      ];
      return {
        id,
        status: 200,
        body: { url, title, snapshot: treeLines.join("\n"), elements },
      };
    }
    if (action === "click") {
      const ref = String(payload.ref ?? "");
      const h = elementMap.get(ref);
      if (!h) {
        return { id, status: 400, body: { error: `Element handle [ref=${ref}] not found` } };
      }
      await h.click({ timeout: 5_000 });
      return { id, status: 200, body: { clicked: ref } };
    }
    if (action === "type") {
      const ref = String(payload.ref ?? "");
      const text = String(payload.text ?? "");
      const h = elementMap.get(ref);
      if (!h) {
        return { id, status: 400, body: { error: `Element handle [ref=${ref}] not found` } };
      }
      await h.fill(text, { timeout: 5_000 });
      return { id, status: 200, body: { typed: ref, value: text } };
    }
    if (action === "press") {
      const key = String(payload.key ?? "Enter");
      await p.keyboard.press(key);
      return { id, status: 200, body: { pressed: key } };
    }
    if (action === "screenshot") {
      const buf = await p.screenshot({ type: "png" });
      const title = await p.title();
      return {
        id,
        status: 200,
        body: {
          mimeType: "image/png",
          url: p.url(),
          title,
          dataBase64: buf.toString("base64"),
        },
      };
    }
    if (action === "console_logs") {
      return { id, status: 200, body: { logs: consoleLogs } };
    }
    if (action === "network_errors") {
      return { id, status: 200, body: { errors: networkErrors } };
    }
    return { id, status: 404, body: { error: `Unknown browser action: ${action}` } };
  } catch (err) {
    return { id, status: 503, body: { error: `Playwright browser worker unavailable: ${err.message}` } };
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on("line", async (line) => {
  if (!line.trim()) return;
  const cmd = JSON.parse(line);
  const res = await handleCommand(cmd);
  process.stdout.write(`${JSON.stringify(res)}\n`);
});
process.on("SIGTERM", async () => {
  if (browser) await browser.close().catch(() => {});
  process.exit(0);
});
