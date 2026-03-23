/**
 * ============================================================
 * Auth-Gen CLI Entry Point (v3.0 - Professional)
 * ============================================================
 * Interactive CLI tool for generating authentication backends
 * and intelligently plugging auth into frontend projects
 * ============================================================
 */

import inquirer from "inquirer";
import path from "path";
import chalk from "chalk";
import ora from "ora";
import { copyTemplate } from "./utils/copyTemplate.js";
import { installDependencies } from "./utils/installDependencies.js";
import { generateEnvFile } from "./utils/generateEnv.js";
import { integrateFrontend } from "./utils/frontendIntegration.js";
import { verifyAndHealAuthFlow } from "./utils/autoHeal.js";

/**
 * Display welcome banner
 */
function displayWelcome() {
  console.clear();
  console.log(chalk.cyan.bold("\n🔐 Auth-Gen — Authentication Backend Generator\n"));
  console.log(chalk.gray("Generate production-ready auth backends & plug into your frontend\n"));
}

/**
 * Main CLI runner
 */
async function run() {
  try {
    displayWelcome();

    // ── STEP 1 — Collect User Configuration ──────────────────
    const answers = await inquirer.prompt([
      {
        type: "list",
        name: "backend",
        message: "Select backend framework:",
        choices: ["Express"],
      },
      {
        type: "list",
        name: "database",
        message: "Select database:",
        choices: ["SQLite"],
      },
      {
        type: "input",
        name: "projectName",
        message: "Project name:",
        default: "my-auth-backend",
        validate: (input: string) => {
          if (!input.trim()) return "Project name cannot be empty";
          if (!/^[a-z0-9-_]+$/i.test(input))
            return "Only letters, numbers, hyphens, and underscores allowed";
          return true;
        },
      },
      {
        type: "input",
        name: "frontendPath",
        message: "Frontend project path (leave empty to skip):",
        default: "",
      },
    ]);

    const templatePath = path.join(
      process.cwd(),
      "templates",
      answers.backend.toLowerCase(),
      answers.database.toLowerCase()
    );

    const projectPath = path.join(process.cwd(), answers.projectName);

    // Resolve frontend path
    let frontendPath = "";
    if (answers.frontendPath) {
      frontendPath = path.isAbsolute(answers.frontendPath)
        ? answers.frontendPath
        : path.resolve(process.cwd(), answers.frontendPath);
    }

    console.log(chalk.gray(`\n📂 Template: ${templatePath}`));
    console.log(chalk.gray(`📁 Backend output: ${projectPath}`));
    if (frontendPath) {
      console.log(chalk.gray(`🎨 Frontend: ${frontendPath}`));
    }
    console.log();

    // ── STEP 2 — Copy Backend Template ───────────────────────
    await copyTemplate(templatePath, projectPath);

    // ── STEP 3 — Generate .env File ──────────────────────────
    await generateEnvFile(projectPath, answers.database);

    // ── STEP 4 — Install Backend Dependencies ────────────────
    const { install } = await inquirer.prompt([
      {
        type: "confirm",
        name: "install",
        message: "Install backend dependencies now?",
        default: true,
      },
    ]);

    if (install) {
      await installDependencies(projectPath);
    }

    // ── STEP 5 — Frontend Integration ────────────────────────
    if (frontendPath) {
      const { confirmPlug } = await inquirer.prompt([
        {
          type: "confirm",
          name: "confirmPlug",
          message: `Plug authentication into ${path.basename(frontendPath)}?`,
          default: true,
        },
      ]);

      if (confirmPlug) {
        const backendUrl = "http://localhost:5000";
        await integrateFrontend(frontendPath, projectPath, backendUrl);

        const { confirmHeal } = await inquirer.prompt([
          {
            type: "confirm",
            name: "confirmHeal",
            message:
              "Run automated health check to verify and heal the authentication flow?",
            default: true,
          },
        ]);

        if (confirmHeal) {
          await verifyAndHealAuthFlow({
            backendPath: projectPath,
            frontendPath: frontendPath,
            detectedFields: [], // This can be enhanced to use fields from the scanner
          });
        }
      }
    }

    // ── STEP 6 — Final Instructions ──────────────────────────
    console.log(chalk.green.bold("\n✅ Project generated successfully!\n"));
    console.log(chalk.cyan("Next steps:"));
    console.log(chalk.white(`  cd ${answers.projectName}`));
    if (!install) {
      console.log(chalk.white(`  npm install`));
    }
    console.log(chalk.white(`  npm run dev`));
    console.log(chalk.gray("\nYour auth backend is ready! 🚀\n"));
  } catch (error) {
    console.error(chalk.red("\n❌ Error:"), error);
    process.exit(1);
  }
}

run();
