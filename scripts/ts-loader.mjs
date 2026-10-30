import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const WORKSPACE_MAP = {
  "@openharness/sdk": path.join(ROOT_DIR, "packages/sdk/src/index.ts"),
  "@openharness/core": path.join(ROOT_DIR, "packages/core/src/index.ts"),
  "@openharness/server": path.join(ROOT_DIR, "packages/server/src/index.ts"),
  "@openharness/sandboxd": path.join(ROOT_DIR, "packages/sandboxd/src/index.ts"),
  "@openharness/cli": path.join(ROOT_DIR, "packages/cli/src/index.ts"),
  "openharness/sdk": path.join(ROOT_DIR, "packages/sdk/src/index.ts"),
  "openharness/core": path.join(ROOT_DIR, "packages/core/src/index.ts"),
  "openharness/server": path.join(ROOT_DIR, "packages/server/src/index.ts"),
  "openharness/sandboxd": path.join(ROOT_DIR, "packages/sandboxd/src/index.ts"),
  "openharness/cli": path.join(ROOT_DIR, "packages/cli/src/index.ts"),
};

export async function resolve(specifier, context, nextResolve) {
  if (WORKSPACE_MAP[specifier]) {
    return {
      url: pathToFileURL(WORKSPACE_MAP[specifier]).href,
      shortCircuit: true,
    };
  }
  for (const [prefix, target] of Object.entries(WORKSPACE_MAP)) {
    if (specifier.startsWith(prefix + "/")) {
      const sub = specifier.slice(prefix.length + 1);
      const baseDir = path.dirname(target);
      const candidate = resolveFilePath(path.join(baseDir, sub));
      if (candidate) {
        return {
          url: pathToFileURL(candidate).href,
          shortCircuit: true,
        };
      }
    }
  }
  if (specifier.startsWith("@/")) {
    const sub = specifier.slice(2);
    const candidate = resolveFilePath(path.join(ROOT_DIR, "src", sub));
    if (candidate) {
      return {
        url: pathToFileURL(candidate).href,
        shortCircuit: true,
      };
    }
  }
  if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const parentPath = context.parentURL ? fileURLToPath(context.parentURL) : ROOT_DIR;
    const parentDir = path.dirname(parentPath);
    const resolved = resolveFilePath(path.resolve(parentDir, specifier));
    if (resolved) {
      return {
        url: pathToFileURL(resolved).href,
        shortCircuit: true,
      };
    }
  }
  return nextResolve(specifier, context);
}

function resolveFilePath(basePath) {
  if (fs.existsSync(basePath) && fs.statSync(basePath).isFile()) return basePath;
  for (const ext of [".ts", ".tsx", ".mjs", ".js"]) {
    if (fs.existsSync(basePath + ext) && fs.statSync(basePath + ext).isFile()) {
      return basePath + ext;
    }
  }
  if (fs.existsSync(basePath) && fs.statSync(basePath).isDirectory()) {
    for (const ext of ["index.ts", "index.mjs", "index.js"]) {
      const idx = path.join(basePath, ext);
      if (fs.existsSync(idx)) return idx;
    }
  }
  return null;
}

export async function load(url, context, nextLoad) {
  if (url.endsWith(".ts") || url.endsWith(".tsx")) {
    const filePath = fileURLToPath(url);
    const raw = fs.readFileSync(filePath, "utf8");
    const transformed = transpileTypeScript(raw);
    return {
      format: "module",
      source: transformed,
      shortCircuit: true,
    };
  }
  return nextLoad(url, context);
}

export function transpileTypeScript(source) {
  let code = source;

  // 1. Remove `import type ... from ...;` and `export type { ... } ...;`
  code = code.replace(/^\s*import\s+type\s+[\s\S]*?from\s+["'][^"']+["']\s*;?\s*$/gm, "");
  code = code.replace(/^\s*export\s+type\s*\{[\s\S]*?\}(?:\s*from\s*["'][^"']+["'])?\s*;?\s*$/gm, "");

  // 2. Strip inline `type ` specifiers inside import/export braces: `import { type Foo, Bar }`
  code = code.replace(/\b(import|export)\s*\{([^}]*)\}/g, (_match, kw, inner) => {
    const cleaned = inner
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s && !/^type\s+\S+$/.test(s))
      .join(", ");
    if (!cleaned && kw === "import") {
      return "import {}";
    }
    return `${kw} { ${cleaned} }`;
  });
  code = code.replace(/^\s*import\s*\{\s*\}\s*from\s*["'][^"']+["']\s*;?\s*$/gm, "");

  // 3. Remove `export interface ... { ... }` and `type ... = ...` blocks
  code = stripInterfaceAndTypeBlocks(code);

  // 4. Remove access modifiers and `readonly` on class fields/methods/constructor params
  code = code.replace(/\b(public|private|protected)\s+readonly\s+/g, "");
  code = code.replace(/\b(public|private|protected)\s+(?=[a-zA-Z_$])/g, "");
  code = code.replace(/\breadonly\s+(?=[a-zA-Z_$[])/g, "");
  code = code.replace(/\boverride\s+(?=[a-zA-Z_$])/g, "");

  // 5. Remove `implements ...` on classes
  code = code.replace(/\bimplements\s+[A-Za-z0-9_$,\s<>]+(?=\{)/g, "");

  // 6. Strip inline type annotations, generics, and `as` assertions
  code = stripTypeAnnotationsAndAssertions(code);


  return code;
}

function stripInterfaceAndTypeBlocks(src) {
  let out = "";
  let i = 0;
  const n = src.length;

  while (i < n) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const end = skipString(src, i);
      out += src.slice(i, end);
      i = end;
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      const end = src.indexOf("\n", i);
      if (end === -1) {
        out += src.slice(i);
        break;
      }
      out += src.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end === -1) {
        out += src.slice(i);
        break;
      }
      out += src.slice(i, end + 2);
      i = end + 2;
      continue;
    }
    if (ch === "/" && src[i + 1] !== "/" && src[i + 1] !== "*" && isRegexStart(out)) {
      const end = skipRegexLiteral(src, i);
      if (end > i + 1) {
        out += src.slice(i, end);
        i = end;
        continue;
      }
    }

    if (i === 0 || src[i - 1] === "\n") {
      const lineMatch = src.slice(i).match(/^(\s*(?:export\s+)?interface\s+[A-Za-z0-9_$]+)/);
      if (lineMatch) {
        let j = i + lineMatch[0].length;
        while (j < n && src[j] !== "{") j++;
        if (j < n && src[j] === "{") {
          j = skipBalanced(src, j, "{", "}");
          while (j < n && (src[j] === " " || src[j] === "\t" || src[j] === ";")) j++;
          i = j;
          continue;
        }
      }

      const typeMatch = src.slice(i).match(/^(\s*(?:export\s+)?type\s+[A-Za-z0-9_$]+(?:\s*<[^>]*>)?\s*=)/);
      if (typeMatch) {
        let j = i + typeMatch[0].length;
        j = skipTypeExpression(src, j);
        i = j;
        continue;
      }
    }

    out += ch;
    i++;
  }
  return out;
}

function skipTypeExpression(src, start) {
  let i = start;
  const n = src.length;
  let depthBrace = 0;
  let depthParen = 0;
  let depthBracket = 0;
  let depthAngle = 0;
  let seenToken = false;

  while (i < n) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      seenToken = true;
      i = skipString(src, i);
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      if (nl === -1) return n;
      i = nl;
    }
    if (ch === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end === -1) return n;
      i = end + 2;
      continue;
    }
    if (!/\s/.test(ch)) seenToken = true;

    if (ch === "{") depthBrace++;
    else if (ch === "}") depthBrace = Math.max(0, depthBrace - 1);
    else if (ch === "(") depthParen++;
    else if (ch === ")") depthParen = Math.max(0, depthParen - 1);
    else if (ch === "[") depthBracket++;
    else if (ch === "]") depthBracket = Math.max(0, depthBracket - 1);
    else if (ch === "<") depthAngle++;
    else if (ch === ">" && src[i - 1] !== "=") depthAngle = Math.max(0, depthAngle - 1);

    if (ch === ";" && depthBrace === 0 && depthParen === 0 && depthBracket === 0 && depthAngle === 0) {
      return i + 1;
    }
    if (ch === "\n" && seenToken && depthBrace === 0 && depthParen === 0 && depthBracket === 0 && depthAngle === 0) {
      const rest = src.slice(i + 1);
      const nextToken = rest.match(/^\s*([|&])/);
      if (!nextToken) {
        return i + 1;
      }
    }
    i++;
  }
  return i;
}

function skipString(src, start) {
  const quote = src[start];
  let i = start + 1;
  const n = src.length;
  while (i < n) {
    if (src[i] === "\\") {
      i += 2;
      continue;
    }
    if (quote === "`" && src[i] === "$" && src[i + 1] === "{") {
      i = skipBalanced(src, i + 1, "{", "}");
      continue;
    }
    if (src[i] === quote) {
      return i + 1;
    }
    i++;
  }
  return n;
}

function skipBalanced(src, start, openChar, closeChar) {
  let depth = 0;
  let i = start;
  const n = src.length;
  while (i < n) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i = skipString(src, i);
      continue;
    }
    if (ch === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      if (nl === -1) return n;
      i = nl + 1;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end === -1) return n;
      i = end + 2;
      continue;
    }
    if (ch === openChar) depth++;
    else if (ch === closeChar) {
      depth--;
      if (depth === 0) return i + 1;
    }
    i++;
  }
  return n;
}

function stripTypeAnnotationsAndAssertions(code) {
  let result = "";
  let i = 0;
  const n = code.length;

  while (i < n) {
    const ch = code[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const end = skipString(code, i);
      result += code.slice(i, end);
      i = end;
      continue;
    }
    if (ch === "/" && code[i + 1] === "/") {
      const end = code.indexOf("\n", i);
      if (end === -1) {
        result += code.slice(i);
        break;
      }
      result += code.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (ch === "/" && code[i + 1] === "*") {
      const end = code.indexOf("*/", i + 2);
      if (end === -1) {
        result += code.slice(i);
        break;
      }
      result += code.slice(i, end + 2);
      i = end + 2;
      continue;
    }
    if (ch === "/" && code[i + 1] !== "/" && code[i + 1] !== "*" && isRegexStart(result)) {
      const end = skipRegexLiteral(code, i);
      if (end > i + 1) {
        result += code.slice(i, end);
        i = end;
        continue;
      }
    }

    if (ch === "<" && code[i + 1] !== "=" && /[A-Za-z0-9_$]/.test(code[i - 1] || "")) {
      const genericEnd = trySkipGenericAngle(code, i);
      if (genericEnd !== -1) {
        i = genericEnd;
        continue;
      }
    }

    if (
      ch === "!" &&
      code[i + 1] !== "=" &&
      /[A-Za-z0-9_$\])]/.test(result.slice(-1)) &&
      /[.,;)\]\s:]/.test(code[i + 1] || "")
    ) {
      i++;
      continue;
    }

    if (
      (ch === " " || ch === "\t") &&
      code.slice(i).match(/^\s+as\s+(?=[A-Za-z0-9_${[("'])/)
    ) {
      const asMatch = code.slice(i).match(/^\s+as\s+/);
      const afterAs = i + asMatch[0].length;
      const typeEnd = skipInlineType(code, afterAs, false);
      if (typeEnd > afterAs) {
        i = typeEnd;
        continue;
      }
    }

    if ((ch === "?" && code[i + 1] === ":") || ch === ":") {
      if (shouldStripColonType(result, code, i)) {
        const colonIdx = ch === "?" ? i + 1 : i;
        const typeEnd = skipInlineType(code, colonIdx + 1, isReturnTypeColon(result));
        if (typeEnd > colonIdx + 1) {
          i = typeEnd;
          continue;
        }
      }
    }

    result += ch;
    i++;
  }

  return result;
}

function trySkipGenericAngle(code, start) {
  let depth = 0;
  let i = start;
  const n = code.length;
  while (i < n && i - start < 500) {
    const ch = code[i];
    if (ch === "<") depth++;
    else if (ch === ">") {
      if (code[i - 1] === "=") { i++; continue; }
      depth--;
      if (depth === 0) {
        const nextNonSpace = code.slice(i + 1).match(/^\s*(.)/);
        const nextCh = nextNonSpace ? nextNonSpace[1] : "";
        if (nextCh === "(" || nextCh === "{" || nextCh === "=" || nextCh === ";") {
          return i + 1;
        }
        return -1;
      }
    } else if (ch === ";" && depth === 0) {
      return -1;
    }
    i++;
  }
  return -1;
}

function isReturnTypeColon(prefix) {
  const trimmed = prefix.trimEnd();
  return trimmed.endsWith(")");
}

function shouldStripColonType(prefix, code, pos) {
  const isQuestionColon = code[pos] === "?" && code[pos + 1] === ":";
  if (isQuestionColon) return true;

  const trimmed = prefix.trimEnd();
  if (trimmed.endsWith(")")) {
    const afterColon = code.slice(pos + 1);
    if (/^\s*[A-Za-z0-9_${[(]/.test(afterColon)) {
      const lastLine = trimmed.split("\n").pop() || "";
      if (lastLine.includes("?")) return false;
      return true;
    }
  }

  const lineStart = trimmed.lastIndexOf("\n") + 1;
  const currentLine = trimmed.slice(lineStart);
  if (/^\s*(?:export\s+)?(?:const|let|var)\s+[A-Za-z0-9_$]+\s*$/.test(currentLine)) {
    return true;
  }

  if (/^\s*(?:static\s+)?[A-Za-z0-9_$]+\s*$/.test(currentLine)) {
    const restLine = (code.slice(pos + 1).split("\n")[0] || "").trim();
    if (!/^(?:async\b|function\b|[0-9"'`\[(]|true\b|false\b|null\b)/.test(restLine)) {
    if (restLine.endsWith(";")) {
      return true;
    }
      const eqMatch = restLine.match(/^([A-Za-z0-9_$<>\[\]|&\s]+)=(?![=>])/);
      if (eqMatch && !restLine.endsWith(",")) {
        return true;
      }
    }
  }

  if (isInsideFunctionParams(trimmed)) {
    return true;
  }

  return false;
}

function isInsideFunctionParams(prefix) {
  let depthParen = 0;
  let depthBrace = 0;
  let lastCommaOrOpen = -1;
  for (let i = prefix.length - 1; i >= 0 && prefix.length - i < 2000; i--) {
    const ch = prefix[i];
    if (ch === ")") depthParen++;
    else if (ch === "(") {
      if (depthParen > 0) depthParen--;
      else {
        if (depthBrace !== 0) return false;
        const paramSegment = prefix.slice(lastCommaOrOpen !== -1 ? lastCommaOrOpen + 1 : i + 1).trim();
        if (paramSegment.includes("?")) return false;
        return /^(?:\.\.\.)?[A-Za-z_$][A-Za-z0-9_$]*$/.test(paramSegment) || /^[\[{][\s\S]*[\]}]$/.test(paramSegment);
      }
    } else if (ch === "}") depthBrace++;
    else if (ch === "{") {
      if (depthBrace > 0) depthBrace--;
      else return false;
    } else if (ch === "," && depthParen === 0 && depthBrace === 0 && lastCommaOrOpen === -1) {
      lastCommaOrOpen = i;
    }
  }
  return false;
}

function skipInlineType(code, start, isReturn) {
  let i = start;
  const n = code.length;
  while (i < n && /\s/.test(code[i])) i++;

  let depthBrace = 0;
  let depthParen = 0;
  let depthBracket = 0;
  let depthAngle = 0;
  let seenTypeBody = false;

  while (i < n) {
    const ch = code[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      seenTypeBody = true;
      i = skipString(code, i);
      continue;
    }
    if (depthBrace === 0 && depthParen === 0 && depthBracket === 0 && depthAngle === 0) {
      if (ch === "=" && code[i + 1] === ">") {
        const typeSoFar = code.slice(start, i).trim();
        if (isReturn && !typeSoFar.startsWith("(")) {
          return i;
        }
        i += 2;
        continue;
      }
      if (ch === "=" || ch === "," || ch === ")" || ch === ";") {
        return i;
      }
      if (ch === "{") {
        if (isReturn && seenTypeBody) {
          // Check if the previous non-whitespace token is `|` or `&` (union with object type)
          const beforeBrace = code.slice(start, i).trimEnd();
          if (!beforeBrace.endsWith("|") && !beforeBrace.endsWith("&")) {
            return i;
          }
        }
        depthBrace++;
        seenTypeBody = true;
        i++;
        continue;
      }
      if (ch === "\n" && seenTypeBody) {
        const rest = code.slice(i + 1);
        if (!/^\s*([|&]|=>)/.test(rest)) {
          return i;
        }
      }
    }

    if (!/\s/.test(ch)) seenTypeBody = true;

    if (ch === "{") depthBrace++;
    else if (ch === "}") {
      if (depthBrace === 0) return i;
      depthBrace--;
    } else if (ch === "(") depthParen++;
    else if (ch === ")") {
      if (depthParen === 0) return i;
      depthParen--;
    } else if (ch === "[") depthBracket++;
    else if (ch === "]") {
      if (depthBracket === 0) return i;
      depthBracket--;
    } else if (ch === "<") depthAngle++;
    else if (ch === ">" && code[i - 1] !== "=") {
      if (depthAngle > 0) depthAngle--;
    }

    i++;
  }
  return i;
}


function isRegexStart(prefix) {
  const t = prefix.trimEnd();
  if (!t) return true;
  const lastCh = t[t.length - 1];
  if ("(,=:[!&|?{};~+-*%^<>".includes(lastCh)) return true;
  if (/\b(?:return|case|throw|typeof|void|delete|in|of|await|yield)$/.test(t)) return true;
  return false;
}

function skipRegexLiteral(src, start) {
  let i = start + 1;
  const n = src.length;
  let inCharClass = false;
  while (i < n) {
    const ch = src[i];
    if (ch === "\n") return start + 1;
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === "[") inCharClass = true;
    else if (ch === "]") inCharClass = false;
    else if (ch === "/" && !inCharClass) {
      i++;
      while (i < n && /[dgimsuvy]/.test(src[i])) i++;
      return i;
    }
    i++;
  }
  return start + 1;
}
