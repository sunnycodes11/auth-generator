import { spawn, ChildProcess } from 'child_process';
import fs from 'fs-extra';
import path from 'path';
import chalk from 'chalk';
import ora from 'ora';

interface HealOptions {
    backendPath: string;
    frontendPath: string;
    detectedFields: string[];
    port?: number;
}

interface TestResult {
    success: boolean;
    error?: string;
    stage?: 'startup' | 'signup' | 'login' | 'config';
    suggestedFix?: 'update_frontend_url' | 'run_migration' | 'none';
    details?: any;
}

/**
 * Main entry point to verify and fix the authentication flow.
 */
export async function verifyAndHealAuthFlow(options: HealOptions) {
    const spinner = ora('Initializing automated integrity checks...').start();
    const PORT = options.port || 5000;
    const BASE_URL = `http://localhost:${PORT}`;

    let backendProcess: ChildProcess | null = null;

    try {
        // 1. Start Backend Server
        spinner.text = `Starting backend server on port ${PORT} for verification...`;
        backendProcess = await startBackendServer(options.backendPath, PORT);
        spinner.succeed(chalk.green('Backend server started successfully via CLI test runner.'));

        // 2. Construct Test Payload based on detected frontend fields
        const testUser = createTestPayload(options.detectedFields);

        // 3. Test Signup Flow
        spinner.start('Testing API: POST /api/auth/signup');
        let signupRes = await fetch(`${BASE_URL}/api/auth/signup`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(testUser)
        });

        // 3a. Auto-Heal: Route Detection
        // If /api/auth/signup fails (404), try root /signup or /api/signup
        let activePrefix = '/api/auth';
        if (signupRes.status === 404) {
            const alternatives = ['/api', '/auth', ''];
            for (const prefix of alternatives) {
                const retryUrl = `${BASE_URL}${prefix}/signup`;
                const retryRes = await fetch(retryUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(testUser)
                });
                if (retryRes.status !== 404) {
                    activePrefix = prefix;
                    signupRes = retryRes;
                    spinner.info(chalk.blue(`Auto-Detected API prefix: "${prefix}" (was expecting "/api/auth")`));

                    // AUTO-FIX: Update frontend config to match this prefix
                    await autoFixFrontendUrl(options.frontendPath, PORT, prefix);
                    break;
                }
            }
        }

        if (!signupRes.ok) {
            const errorText = await signupRes.text();
            throw new Error(`Signup failed (${signupRes.status}): ${errorText}`);
        }

        const signupData = await signupRes.json() as any;
        spinner.succeed(chalk.green('Signup flow verified.'));

        // 4. Test Login Flow
        spinner.start(`Testing API: POST ${activePrefix}/login`);
        const loginRes = await fetch(`${BASE_URL}${activePrefix}/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                email: testUser.email,
                password: testUser.password
            })
        });

        if (!loginRes.ok) {
            throw new Error(`Login failed with status ${loginRes.status}`);
        }

        const loginData = await loginRes.json() as any;
        if (!loginData.token) {
            throw new Error('Login response missing authentication token');
        }
        spinner.succeed(chalk.green('Login flow verified & Token received.'));

        // 5. Verify Frontend Configuration
        // Ensure the frontend source code points to the correct backend URL
        spinner.start('Verifying frontend API configuration...');
        const configFixed = await verifyFrontendConfig(options.frontendPath, BASE_URL, activePrefix);

        if (configFixed) {
            spinner.succeed(chalk.green('Frontend API URL auto-corrected to match backend.'));
        } else {
            spinner.succeed(chalk.green('Frontend configuration matches backend.'));
        }

        console.log(chalk.bold.green('\n✨ INTEGRITY CHECK PASSED: Authentication flow is production-ready.\n'));

    } catch (error: any) {
        spinner.fail(chalk.red(`Integrity Check Failed: ${error.message}`));

        // Attempt specific auto-fixes based on error type
        if (error.message.includes('ECONNREFUSED')) {
            console.log(chalk.yellow('  👉 Suggestion: The backend failed to start. Running "npm install" might fix missing dependencies.'));
        } else if (error.message.includes('no such column')) {
            console.log(chalk.yellow('  👉 Suggestion: Database schema mismatch. The generator sanitization should handle this, but try clearing the database file.'));
        }

    } finally {
        if (backendProcess) {
            backendProcess.kill();
        }
    }
}

// --- Helpers ---

function startBackendServer(cwd: string, port: number): Promise<ChildProcess> {
    return new Promise((resolve, reject) => {
        // Start the server in a separate process
        const child = spawn('npm', ['run', 'dev'], {
            cwd,
            env: { ...process.env, PORT: port.toString() },
            stdio: ['ignore', 'pipe', 'pipe'], // Capture stdout and stderr
            detached: false,
            shell: true, // Use shell to ensure npm command is found, especially on Windows
        });

        let started = false;
        let outputBuffer = '';

        child.stdout?.on('data', (data) => {
            const output = data.toString();
            outputBuffer += output;
            // console.log(chalk.gray(`[Backend STDOUT]: ${output.trim()}`)); // For debugging
            // Detect common "Server started" messages
            if (output.includes(`running on port ${port}`) || output.includes(`listening on port ${port}`) || output.includes('Server started')) {
                if (!started) {
                    started = true;
                    resolve(child);
                }
            }
        });
        child.stderr?.on('data', (data) => {
            const output = data.toString();
            outputBuffer += output;
            // console.error(chalk.red(`[Backend STDERR]: ${output.trim()}`)); // For debugging
        });

        child.on('error', (err) => {
            if (!started) {
                reject(new Error(`Failed to start backend process: ${err.message}`));
            }
        });

        child.on('close', (code) => {
            if (!started && code !== 0) {
                reject(new Error(`Backend process exited with code ${code} during startup. Output:\n${outputBuffer}`));
            }
        });

        // Timeout if server doesn't indicate startup within 15 seconds
        const startupTimeout = setTimeout(() => {
            if (!started) {
                // Check if process is still alive
                if (child.exitCode === null) {
                    // Process is still running but no "started" message, assume it's up
                    started = true;
                    resolve(child);
                } else {
                    // Process exited without indicating startup
                    reject(new Error(`Backend server did not indicate startup within 15 seconds and exited. Output:\n${outputBuffer}`));
                }
            }
        }, 15000); // Increased timeout for potentially slower startups

        // Clear timeout if resolved earlier
        child.on('spawn', () => {
            if (started) clearTimeout(startupTimeout);
        });
    });
}

function createTestPayload(fields: string[]) {
    const payload: any = {
        email: `test_${Date.now()}@example.com`,
        password: 'Password123!',
    };

    // Fill detected custom fields with dummy data
    fields.forEach(field => {
        const cleanField = field.toLowerCase().replace(/[^a-z0-9_]/g, '_');
        if (cleanField !== 'email' && cleanField !== 'password') {
            payload[cleanField] = `test_${cleanField}`;
        }
    });

    return payload;
}

// This function will now primarily call autoFixFrontendUrl
async function verifyFrontendConfig(frontendPath: string, backendUrl: string, apiPrefix: string): Promise<boolean> {
    const port = parseInt(backendUrl.split(':').pop() || '5000');
    // Pass empty string for prefix because generated auth services already contain the full path (e.g. /api/signup)
    // Appending the prefix to the baseURL would result in incorrect URLs like http://localhost:5000/api/api/signup
    return await autoFixFrontendUrl(frontendPath, port, '');
}

/**
 * Updates frontend source files to use the correct API prefix/URL
 * This is the "Auto-Fix" for configuration mismatches
 */
async function autoFixFrontendUrl(frontendPath: string, port: number, correctPrefix: string): Promise<boolean> {
    const correctBaseUrl = `http://localhost:${port}`;
    const fullCorrectApiUrl = `${correctBaseUrl}${correctPrefix}`;

    const apiClientPathTs = path.join(frontendPath, 'src', 'utils', 'apiClient.ts');
    const apiClientPathJs = path.join(frontendPath, 'src', 'utils', 'apiClient.js');

    let filePathToFix: string | null = null;
    if (await fs.pathExists(apiClientPathTs)) {
        filePathToFix = apiClientPathTs;
    } else if (await fs.pathExists(apiClientPathJs)) {
        filePathToFix = apiClientPathJs;
    }

    if (!filePathToFix) {
        console.log(chalk.yellow(`  ⚠️  Could not find 'src/utils/apiClient.ts' or 'src/utils/apiClient.js' in frontend project to auto-fix.`));
        return false;
    }

    let content = await fs.readFile(filePathToFix, 'utf8');
    const baseURLRegex = /baseURL:\s*["'`]([^"'`]+)["'`]/;
    const match = content.match(baseURLRegex);

    if (match && match[1] !== fullCorrectApiUrl) {
        const oldUrl = match[1];
        content = content.replace(baseURLRegex, `baseURL: "${fullCorrectApiUrl}"`);
        await fs.writeFile(filePathToFix, content);
        console.log(chalk.green(`  ✅ Auto-fixed frontend API URL in ${path.relative(frontendPath, filePathToFix)}:`));
        console.log(chalk.gray(`     ${oldUrl} -> ${fullCorrectApiUrl}`));
        return true;
    }

    return false;
}