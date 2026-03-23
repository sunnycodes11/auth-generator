/**
 * ============================================================
 * Backend Route Detector (Step 3)
 * ============================================================
 * Scans the generated backend project to detect auth routes.
 * Returns exact route paths — never hardcoded, always detected.
 * 
 * Detection strategy:
 *  1. Find server entry file → extract base prefix (e.g. /api)
 *  2. Scan route files → extract router.METHOD("/path") patterns
 *  3. Scan controllers → cross-reference handler names
 *  4. Fallback: scan server file for inline app.METHOD routes
 *  5. Last resort: parse console.log endpoint listings
 * ============================================================
 */

import fs from "fs-extra";
import path from "path";

export interface DetectedRoute {
  method: string;        // GET, POST, PUT, DELETE
  path: string;          // Full path e.g. /api/signup
  purpose: "register" | "login" | "logout" | "user" | "health" | "unknown";
  handler: string;       // Function name e.g. "signup"
  requiresAuth: boolean;
}

export interface BackendRouteResult {
  routes: DetectedRoute[];
  basePrefix: string;    // e.g. "/api"
  serverFile: string | null;
  routeFiles: string[];
}

/**
 * Detect all auth routes from the generated backend project
 */
export async function detectBackendRoutes(backendPath: string): Promise<BackendRouteResult> {
  const result: BackendRouteResult = {
    routes: [],
    basePrefix: "",
    serverFile: null,
    routeFiles: [],
  };

  // ── Step 1: Find server entry file & detect base prefix ───
  const serverCandidates = [
    "server.ts", "server.js",
    "src/server.ts", "src/server.js",
    "index.ts", "index.js",
    "src/index.ts", "src/index.js",
    "app.ts", "app.js",
    "src/app.ts", "src/app.js",
  ];

  let serverContent = "";

  for (const candidate of serverCandidates) {
    const fullPath = path.join(backendPath, candidate);
    if (await fs.pathExists(fullPath)) {
      result.serverFile = candidate;
      serverContent = await fs.readFile(fullPath, "utf-8");

      // Detect base prefix: app.use("/api", authRoutes)
      const prefixMatches = serverContent.matchAll(
        /app\.use\s*\(\s*["'`](\/[^"'`]*)["'`]\s*,\s*\w+/g
      );
      for (const m of prefixMatches) {
        // Use the first prefix that looks like an API prefix
        const prefix = m[1];
        if (prefix !== "/") {
          result.basePrefix = prefix;
          break;
        }
      }
      break;
    }
  }

  // ── Step 2: Scan route files ──────────────────────────────
  const routeDirs = ["routes", "src/routes", "router", "src/router"];

  for (const dir of routeDirs) {
    const fullDir = path.join(backendPath, dir);
    if (!(await fs.pathExists(fullDir))) continue;

    const files = await fs.readdir(fullDir);
    for (const file of files) {
      if (!/\.(ts|js)$/.test(file) || file.includes(".d.ts")) continue;

      const filePath = path.join(fullDir, file);
      const relativePath = path.join(dir, file);
      result.routeFiles.push(relativePath);

      const content = await fs.readFile(filePath, "utf-8");
      const routes = parseRouteFile(content, result.basePrefix);
      result.routes.push(...routes);
    }
  }

  // ── Step 3: Fallback — scan server file for inline routes ─
  if (result.routes.length === 0 && serverContent) {
    const inlineRoutes = parseInlineRoutes(serverContent);
    result.routes.push(...inlineRoutes);
  }

  // ── Step 4: Last resort — parse console.log endpoint listings
  if (result.routes.length === 0 && serverContent) {
    const logRoutes = parseLoggedEndpoints(serverContent);
    result.routes.push(...logRoutes);
  }

  // Deduplicate routes by method+path
  const seen = new Set<string>();
  result.routes = result.routes.filter((r) => {
    const key = `${r.method}:${r.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return result;
}

/**
 * Parse a route file for router.METHOD("/path", ...handlers)
 */
function parseRouteFile(content: string, basePrefix: string): DetectedRoute[] {
  const routes: DetectedRoute[] = [];

  const routeRegex = /router\.(get|post|put|patch|delete)\s*\(\s*["'`](\/[^"'`]*)["'`]\s*,?\s*([^)]*)\)/gi;
  let match;

  while ((match = routeRegex.exec(content)) !== null) {
    const method = match[1].toUpperCase();
    const routePath = match[2];
    const handlerArgs = match[3].trim();
    const fullPath = basePrefix + routePath;

    const requiresAuth =
      /authenticate|authMiddleware|protect|verifyToken|requireAuth|isAuthenticated/i.test(handlerArgs);

    // Last identifier in the handler args is the controller
    const handlerMatch = handlerArgs.match(/(\w+)\s*$/);
    const handler = handlerMatch ? handlerMatch[1] : "unknown";

    routes.push({
      method,
      path: fullPath,
      purpose: classifyRoute(routePath, handler),
      handler,
      requiresAuth,
    });
  }

  return routes;
}

/**
 * Parse routes defined inline on app: app.post("/api/login", ...)
 */
function parseInlineRoutes(content: string): DetectedRoute[] {
  const routes: DetectedRoute[] = [];

  const routeRegex = /app\.(get|post|put|patch|delete)\s*\(\s*["'`](\/[^"'`]*)["'`]\s*,?\s*([^)]*)\)/gi;
  let match;

  while ((match = routeRegex.exec(content)) !== null) {
    const method = match[1].toUpperCase();
    const routePath = match[2];
    const handlerArgs = match[3].trim();

    // Skip middleware-like routes (app.use patterns captured separately)
    if (routePath === "/" || routePath === "*") continue;

    const requiresAuth =
      /authenticate|authMiddleware|protect|verifyToken|requireAuth/i.test(handlerArgs);

    const handlerMatch = handlerArgs.match(/(\w+)\s*$/);
    const handler = handlerMatch ? handlerMatch[1] : "unknown";

    routes.push({
      method,
      path: routePath,
      purpose: classifyRoute(routePath, handler),
      handler,
      requiresAuth,
    });
  }

  return routes;
}

/**
 * Parse endpoint info from console.log/console.info statements
 * e.g. console.log(`  POST   /api/signup     - Register new user`);
 */
function parseLoggedEndpoints(content: string): DetectedRoute[] {
  const routes: DetectedRoute[] = [];

  const logRegex = /(GET|POST|PUT|PATCH|DELETE)\s+(\/\S+)/gi;
  let match;

  while ((match = logRegex.exec(content)) !== null) {
    const method = match[1].toUpperCase();
    const routePath = match[2].replace(/[`'"]/g, "").trim();

    // Skip health endpoints for auth purposes
    const purpose = classifyRoute(routePath, "");
    if (purpose === "unknown") continue;

    routes.push({
      method,
      path: routePath,
      purpose,
      handler: purpose,
      requiresAuth: routePath.includes("user"),
    });
  }

  return routes;
}

/**
 * Classify a route's purpose based on path and handler name
 */
function classifyRoute(routePath: string, handler: string): DetectedRoute["purpose"] {
  const combined = (routePath + " " + handler).toLowerCase();

  if (combined.includes("signup") || combined.includes("sign-up") || combined.includes("register")) return "register";
  if (combined.includes("login") || combined.includes("signin") || combined.includes("sign-in")) return "login";
  if (combined.includes("logout") || combined.includes("signout") || combined.includes("sign-out")) return "logout";
  if (combined.includes("user") || combined.includes("profile") || combined.includes("me")) return "user";
  if (combined.includes("health") || combined.includes("ping") || combined.includes("status")) return "health";

  return "unknown";
}
