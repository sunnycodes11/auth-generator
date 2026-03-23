/**
 * ============================================================
 * Frontend Integration Orchestrator (Steps 1–10)
 * ============================================================
 * Professional CLI module that:
 *  1. Detects frontend root
 *  2. Detects frontend language
 *  3. Detects backend auth routes
 *  4. Ensures required folder structure
 *  5–7. Generates auth service, apiClient, useAuth, AuthContext
 *  8. Detects login/register components
 *  9. Injects auth imports into components
 * 10. Prints CLI output summary
 * ============================================================
 */

import fs from "fs-extra";
import path from "path";
import chalk from "chalk";
import ora from "ora";
import { exec } from "child_process";
import { promisify } from "util";
import { detectBackendRoutes, DetectedRoute, BackendRouteResult } from "./backendRouteDetector.js";
import { generateFrontendFiles, GeneratedFile } from "./frontendFileGenerator.js";

const execAsync = promisify(exec);

export interface FrontendIntegrationResult {
  success: boolean;
  framework: string;
  language: string;
  extension: string;
  routesDetected: DetectedRoute[];
  foldersCreated: string[];
  filesGenerated: string[];
  importsInjected: string[];
  errors: string[];
}

/**
 * Main entry point — runs all 10 steps
 */
export async function integrateFrontend(
  frontendPath: string,
  backendPath: string,
  backendUrl: string
): Promise<FrontendIntegrationResult> {
  const result: FrontendIntegrationResult = {
    success: false,
    framework: "unknown",
    language: "unknown",
    extension: ".js",
    routesDetected: [],
    foldersCreated: [],
    filesGenerated: [],
    importsInjected: [],
    errors: [],
  };

  console.log(chalk.cyan.bold("\n🔐 Auth-Gen — Frontend Integration\n"));
  console.log(chalk.gray("  Scanning frontend project...\n"));

  // ── Step 1: Detect frontend root ──────────────────────────
  const spinner1 = ora("Step 1/10 — Detecting frontend project...").start();
  const frontendRoot = await detectFrontendRoot(frontendPath);
  if (!frontendRoot) {
    spinner1.fail(chalk.red("Frontend project not detected."));
    console.log(chalk.yellow("\n  ⚠️  Could not find src/ directory."));
    console.log(chalk.gray("  Make sure you're pointing to a valid frontend project.\n"));
    result.errors.push("Frontend project not detected — no src/ directory found.");
    return result;
  }
  spinner1.succeed(chalk.green(`Frontend detected: ${frontendRoot}`));

  // ── Step 2: Detect frontend language ──────────────────────
  const spinner2 = ora("Step 2/10 — Detecting frontend language...").start();
  const { language, extension, framework } = await detectFrontendLanguage(frontendRoot);
  result.language = language;
  result.extension = extension;
  result.framework = framework;
  spinner2.succeed(chalk.green(`Language: ${language} (${extension})`));
  if (framework !== "unknown") {
    console.log(chalk.gray(`  Framework: ${framework}`));
  }

  // ── Step 3: Detect backend auth routes ────────────────────
  const spinner3 = ora("Step 3/10 — Detecting backend auth routes...").start();
  const backendRoutes = await detectBackendRoutes(backendPath);
  result.routesDetected = backendRoutes.routes;

  if (backendRoutes.routes.length === 0) {
    spinner3.warn(chalk.yellow("No backend routes detected — using default routes."));
    backendRoutes.routes.push(
      { method: "POST", path: "/api/signup", purpose: "register", handler: "signup", requiresAuth: false },
      { method: "POST", path: "/api/login", purpose: "login", handler: "login", requiresAuth: false },
      { method: "GET", path: "/api/users", purpose: "user", handler: "getAllUsers", requiresAuth: true },
    );
  } else {
    spinner3.succeed(chalk.green(`Backend routes detected: ${backendRoutes.routes.length}`));
  }

  // Print detected routes
  console.log(chalk.gray("\n  Backend routes:"));
  for (const route of backendRoutes.routes) {
    const authBadge = route.requiresAuth ? chalk.yellow(" 🔒") : "";
    console.log(chalk.gray(`    ${route.method.padEnd(6)} ${route.path}${authBadge}`));
  }
  console.log();

  // ── Step 4: Ensure required folder structure ──────────────
  const spinner4 = ora("Step 4/10 — Checking frontend structure...").start();
  const srcPath = path.join(frontendRoot, "src");
  const requiredDirs = ["services", "hooks", "context", "utils"];

  for (const dir of requiredDirs) {
    const dirPath = path.join(srcPath, dir);
    if (!(await fs.pathExists(dirPath))) {
      await fs.ensureDir(dirPath);
      result.foldersCreated.push(`src/${dir}`);
    }
  }

  if (result.foldersCreated.length > 0) {
    spinner4.succeed(chalk.green(`Created ${result.foldersCreated.length} folder(s)`));
    for (const folder of result.foldersCreated) {
      console.log(chalk.green(`    ✓ ${folder}/`));
    }
  } else {
    spinner4.succeed(chalk.green("All required folders exist"));
  }

  // ── Install axios ─────────────────────────────────────────
  const spinner5 = ora("Installing axios...").start();
  const axiosResult = await ensureAxiosInstalled(frontendRoot);
  if (axiosResult === "installed") {
    spinner5.succeed(chalk.green("axios installed successfully"));
  } else if (axiosResult === "exists") {
    spinner5.succeed(chalk.green("axios already installed"));
  } else {
    spinner5.warn(chalk.yellow("Could not install axios — run manually: npm install axios"));
    result.errors.push("axios auto-install failed");
  }

  // ── Steps 5–7: Generate frontend files ────────────────────
  const spinner6 = ora("Steps 5-7/10 — Generating frontend integration files...").start();
  const generatedFiles = generateFrontendFiles(extension, backendRoutes.routes, backendUrl);

  for (const file of generatedFiles) {
    const fullPath = path.join(frontendRoot, file.relativePath);

    // Never overwrite existing user files
    if (await fs.pathExists(fullPath)) {
      console.log(chalk.gray(`    ⏭ Skipped (exists): ${file.relativePath}`));
      continue;
    }

    await fs.ensureDir(path.dirname(fullPath));
    await fs.writeFile(fullPath, file.content, "utf-8");
    result.filesGenerated.push(file.relativePath);
  }

  spinner6.succeed(chalk.green(`Generated ${result.filesGenerated.length} file(s)`));
  for (const file of result.filesGenerated) {
    console.log(chalk.green(`    ✓ ${file}`));
  }

  // ── Steps 8–9: Detect components and inject imports ───────
  const spinner7 = ora("Steps 8-9/10 — Scanning for login/register components...").start();
  const components = await detectAuthComponents(srcPath);

  if (components.length > 0) {
    spinner7.succeed(chalk.green(`Found ${components.length} auth component(s)`));

    for (const comp of components) {
      console.log(chalk.gray(`    • ${comp.relativePath} (${comp.purpose})`));
      const injected = await injectAuthImport(comp, frontendRoot, extension);
      if (injected) {
        result.importsInjected.push(comp.relativePath);
        console.log(chalk.green(`      ✓ Import injected`));
      } else {
        console.log(chalk.gray(`      ⏭ Import already present`));
      }
    }
  } else {
    spinner7.info(chalk.gray("No login/register components found — imports can be added manually"));
  }

  // ── Step 10: Print summary ────────────────────────────────
  printSummary(result);

  result.success = true;
  return result;
}

// ═══════════════════════════════════════════════════════════
// Step 1 — Detect Frontend Root
// ═══════════════════════════════════════════════════════════

async function detectFrontendRoot(targetPath: string): Promise<string | null> {
  const absPath = path.resolve(targetPath);

  // Check for src/ at the target path
  const markers = ["src", "src/pages", "src/components", "src/app", "src/views"];
  for (const marker of markers) {
    if (await fs.pathExists(path.join(absPath, marker))) {
      return absPath;
    }
  }

  // Check if the path IS the src/ directory
  if (path.basename(absPath) === "src" && (await fs.pathExists(absPath))) {
    return path.dirname(absPath);
  }

  return null;
}

// ═══════════════════════════════════════════════════════════
// Step 2 — Detect Frontend Language
// ═══════════════════════════════════════════════════════════

interface LanguageDetection {
  language: string;
  extension: string;
  framework: string;
}

async function detectFrontendLanguage(frontendRoot: string): Promise<LanguageDetection> {
  const srcPath = path.join(frontendRoot, "src");

  const counts: Record<string, number> = { ".tsx": 0, ".ts": 0, ".jsx": 0, ".js": 0 };
  await countExtensions(srcPath, counts);

  // Priority: .tsx > .ts > .jsx > .js
  let language = "JavaScript";
  let extension = ".js";

  if (counts[".tsx"] > 0) {
    language = "React TypeScript";
    extension = ".ts"; // Non-JSX utilities use .ts
  } else if (counts[".ts"] > 0) {
    language = "TypeScript";
    extension = ".ts";
  } else if (counts[".jsx"] > 0) {
    language = "React JavaScript";
    extension = ".js";
  }

  // Detect framework
  let framework = "unknown";
  const pkgPath = path.join(frontendRoot, "package.json");
  if (await fs.pathExists(pkgPath)) {
    try {
      const pkg = await fs.readJson(pkgPath);
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };

      if ("next" in allDeps) framework = "Next.js";
      else if ("react-scripts" in allDeps) framework = "Create React App";
      else if ("react" in allDeps && "vite" in allDeps) framework = "React (Vite)";
      else if ("react" in allDeps) framework = "React";
      else if ("nuxt" in allDeps) framework = "Nuxt";
      else if ("vue" in allDeps) framework = "Vue";
      else if ("@angular/core" in allDeps) framework = "Angular";
      else if ("svelte" in allDeps) framework = "Svelte";
    } catch {
      // Ignore
    }
  }

  return { language, extension, framework };
}

async function countExtensions(dir: string, counts: Record<string, number>): Promise<void> {
  const skip = new Set(["node_modules", "dist", ".next", "build", ".git", "public", "coverage", "__tests__"]);
  if (!(await fs.pathExists(dir))) return;

  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!skip.has(entry.name)) {
        await countExtensions(path.join(dir, entry.name), counts);
      }
    } else {
      const ext = path.extname(entry.name);
      if (ext in counts) counts[ext]++;
    }
  }
}

// ═══════════════════════════════════════════════════════════
// Install axios
// ═══════════════════════════════════════════════════════════

async function ensureAxiosInstalled(frontendRoot: string): Promise<"installed" | "exists" | "failed"> {
  const pkgPath = path.join(frontendRoot, "package.json");

  if (await fs.pathExists(pkgPath)) {
    try {
      const pkg = await fs.readJson(pkgPath);
      const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
      if ("axios" in allDeps) return "exists";
    } catch {
      // Continue to install
    }
  }

  // Detect package manager
  let cmd = "npm install axios";
  if (await fs.pathExists(path.join(frontendRoot, "yarn.lock"))) cmd = "yarn add axios";
  else if (await fs.pathExists(path.join(frontendRoot, "pnpm-lock.yaml"))) cmd = "pnpm add axios";
  else if (await fs.pathExists(path.join(frontendRoot, "bun.lockb"))) cmd = "bun add axios";

  try {
    await execAsync(cmd, { cwd: frontendRoot, timeout: 60000 });
    return "installed";
  } catch {
    return "failed";
  }
}

// ═══════════════════════════════════════════════════════════
// Steps 8–9 — Detect auth components and inject imports
// ═══════════════════════════════════════════════════════════

interface AuthComponent {
  absolutePath: string;
  relativePath: string;
  purpose: "login" | "register";
}

/**
 * Scan src/ for login/register/signup components in pages, components, app, views
 */
async function detectAuthComponents(srcPath: string): Promise<AuthComponent[]> {
  const components: AuthComponent[] = [];
  const searchDirs = ["pages", "components", "app", "views", "features", "screens"];

  for (const dir of searchDirs) {
    const dirPath = path.join(srcPath, dir);
    if (await fs.pathExists(dirPath)) {
      await findAuthFiles(dirPath, srcPath, components);
    }
  }

  // Also scan src/ root level
  await findAuthFilesShallow(srcPath, srcPath, components);

  return components;
}

async function findAuthFiles(dir: string, srcPath: string, results: AuthComponent[]): Promise<void> {
  const skip = new Set(["node_modules", "dist", "__tests__", "test", ".git"]);
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      if (!skip.has(entry.name)) {
        await findAuthFiles(fullPath, srcPath, results);
      }
      continue;
    }

    classifyAuthFile(entry.name, fullPath, srcPath, results);
  }
}

async function findAuthFilesShallow(dir: string, srcPath: string, results: AuthComponent[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile()) {
      classifyAuthFile(entry.name, path.join(dir, entry.name), srcPath, results);
    }
  }
}

function classifyAuthFile(
  fileName: string,
  fullPath: string,
  srcPath: string,
  results: AuthComponent[]
): void {
  const ext = path.extname(fileName);
  if (![".js", ".jsx", ".ts", ".tsx", ".vue"].includes(ext)) return;

  const nameLower = fileName.toLowerCase().replace(ext, "");

  const loginPatterns = [
    "login", "signin", "sign-in", "loginform", "signinform",
    "loginpage", "signinpage", "loginview", "signinview",
    "loginscreen", "signinscreen",
  ];
  const registerPatterns = [
    "register", "signup", "sign-up", "registerform", "signupform",
    "registerpage", "signuppage", "registerview", "signupview",
    "registerscreen", "signupscreen",
  ];

  if (loginPatterns.some((p) => nameLower === p || nameLower.includes(p))) {
    results.push({
      absolutePath: fullPath,
      relativePath: path.relative(srcPath, fullPath),
      purpose: "login",
    });
    return;
  }

  if (registerPatterns.some((p) => nameLower === p || nameLower.includes(p))) {
    results.push({
      absolutePath: fullPath,
      relativePath: path.relative(srcPath, fullPath),
      purpose: "register",
    });
  }
}

/**
 * Step 9 — Inject auth import into a component file
 * Safe: no duplicates, preserves existing syntax
 */
async function injectAuthImport(
  component: AuthComponent,
  frontendRoot: string,
  ext: string
): Promise<boolean> {
  const content = await fs.readFile(component.absolutePath, "utf-8");

  // Build relative import path from component to services/auth
  const componentDir = path.dirname(component.absolutePath);
  const servicesDir = path.join(frontendRoot, "src", "services");
  let importPath = path.relative(componentDir, path.join(servicesDir, "auth"));

  // Normalize to posix separators and ensure relative prefix
  importPath = importPath.split(path.sep).join("/");
  if (!importPath.startsWith(".")) importPath = "./" + importPath;

  const functionName = component.purpose === "login" ? "login" : "register";
  const importStatement = `import { ${functionName} } from "${importPath}";`;

  // Check if already imported from services/auth (any path variant)
  if (content.includes("services/auth") || content.includes("services\\auth")) {
    return false;
  }

  // Find the last import line and inject after it
  const lines = content.split("\n");
  let lastImportLine = -1;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("import ") || trimmed.startsWith("} from ")) {
      lastImportLine = i;
    }
    // Stop after leaving the import block
    if (lastImportLine >= 0 && trimmed !== "" && !trimmed.startsWith("import ") &&
        !trimmed.startsWith("} from ") && !trimmed.startsWith("//") && !trimmed.startsWith("/*")) {
      break;
    }
  }

  if (lastImportLine >= 0) {
    lines.splice(lastImportLine + 1, 0, importStatement);
  } else {
    lines.unshift(importStatement);
  }

  await fs.writeFile(component.absolutePath, lines.join("\n"), "utf-8");
  return true;
}

// ═══════════════════════════════════════════════════════════
// Step 10 — Summary
// ═══════════════════════════════════════════════════════════

function printSummary(result: FrontendIntegrationResult): void {
  console.log(chalk.cyan.bold("\n════════════════════════════════════════════"));
  console.log(chalk.cyan.bold("  ✅ Auth-Gen Frontend Integration Complete"));
  console.log(chalk.cyan.bold("════════════════════════════════════════════\n"));

  console.log(chalk.white(`  Framework:     ${result.framework}`));
  console.log(chalk.white(`  Language:      ${result.language} (${result.extension})`));
  console.log(chalk.white(`  Routes:        ${result.routesDetected.length} detected`));
  console.log(chalk.white(`  Folders:       ${result.foldersCreated.length} created`));
  console.log(chalk.white(`  Files:         ${result.filesGenerated.length} generated`));
  console.log(chalk.white(`  Imports:       ${result.importsInjected.length} injected`));

  if (result.errors.length > 0) {
    console.log(chalk.yellow(`\n  ⚠️  Warnings:`));
    for (const err of result.errors) {
      console.log(chalk.yellow(`    - ${err}`));
    }
  }

  console.log(chalk.green("\n  Authentication successfully plugged into frontend.\n"));

  console.log(chalk.gray("  Usage in your components:\n"));
  console.log(chalk.gray('    import { login, register } from "./services/auth";'));
  console.log(chalk.gray('    import { useAuth } from "./hooks/useAuth";'));
  console.log(chalk.gray('    import { AuthProvider } from "./context/AuthContext";\n'));
}
