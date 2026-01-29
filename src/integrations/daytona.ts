import { tool } from 'ai';
import { Daytona, type Sandbox } from '@daytonaio/sdk';
import { z } from 'zod';
import { BaseIntegration } from './base.js';
import { loadConfig } from '../lib/config.js';
import { createToolError, toToolError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

const SANDBOX_TIMEOUT_MS = 30000;
const DEFAULT_LANGUAGE = 'python';

type SandboxLanguage = 'python' | 'typescript' | 'javascript';

interface DaytonaConfig {
  apiKey?: string;
  apiUrl?: string;
  target?: string;
}

const getDaytonaConfig = (): DaytonaConfig => {
  const config = loadConfig();
  return {
    apiKey: config.daytona?.apiKey || process.env.DAYTONA_API_KEY,
    apiUrl: config.daytona?.apiUrl || process.env.DAYTONA_API_URL,
    target: config.daytona?.target || process.env.DAYTONA_TARGET,
  };
};

const getDaytona = (): Daytona => {
  const config = getDaytonaConfig();
  if (!config.apiKey) {
    throw new Error('DAYTONA_API_KEY is required');
  }
  return new Daytona({
    apiKey: config.apiKey,
    apiUrl: config.apiUrl,
    target: config.target,
  });
};

const formatCodeResult = (result: string, exitCode: number): string => {
  if (exitCode === 0) {
    return result || '(no output)';
  }
  return `Exit code ${exitCode}:\n${result}`;
};

export class DaytonaIntegration extends BaseIntegration {
  id = 'daytona';
  name = 'Daytona';
  description = 'Execute code securely in isolated sandbox environments';
  icon = '🏖️';

  private activeSandboxes = new Map<string, Sandbox>();

  isEnabled(): boolean {
    const config = getDaytonaConfig();
    return !!config.apiKey;
  }

  getTools() {
    return {
      execute_code: tool({
        description:
          'Execute code in a secure, isolated Daytona sandbox. ' +
          'Supports Python, TypeScript, and JavaScript. ' +
          'Use this for data analysis, calculations, or running scripts safely.',
        inputSchema: z.object({
          code: z.string().describe('The code to execute'),
          language: z
            .enum(['python', 'typescript', 'javascript'])
            .optional()
            .describe('Programming language (default: python)'),
          timeout: z
            .number()
            .int()
            .min(1000)
            .max(300000)
            .optional()
            .describe('Timeout in milliseconds (default: 30000)'),
        }),
        execute: async ({
          code,
          language,
          timeout,
        }: {
          code: string;
          language?: SandboxLanguage;
          timeout?: number;
        }) => {
          const lang = language || DEFAULT_LANGUAGE;
          const timeoutMs = timeout || SANDBOX_TIMEOUT_MS;

          try {
            const daytona = getDaytona();
            const sandbox = await daytona.create({
              language: lang,
              autoStopInterval: 5,
            });

            try {
              const response = await sandbox.process.codeRun(code, undefined, timeoutMs);
              return {
                success: response.exitCode === 0,
                output: formatCodeResult(response.result, response.exitCode),
                exitCode: response.exitCode,
                language: lang,
              };
            } finally {
              await sandbox.delete().catch((err) => {
                logger.warn({ err, sandboxId: sandbox.id }, '[Daytona] Failed to delete sandbox');
              });
            }
          } catch (error) {
            return toToolError(this.id, error);
          }
        },
      }),

      execute_command: tool({
        description:
          'Execute a shell command in a secure Daytona sandbox. ' +
          'Use for running CLI tools, installing packages, or system operations.',
        inputSchema: z.object({
          command: z.string().describe('The shell command to execute'),
          workDir: z
            .string()
            .optional()
            .describe('Working directory (default: home directory)'),
          timeout: z
            .number()
            .int()
            .min(1000)
            .max(300000)
            .optional()
            .describe('Timeout in milliseconds (default: 30000)'),
        }),
        execute: async ({
          command,
          workDir,
          timeout,
        }: {
          command: string;
          workDir?: string;
          timeout?: number;
        }) => {
          const timeoutMs = timeout || SANDBOX_TIMEOUT_MS;

          try {
            const daytona = getDaytona();
            const sandbox = await daytona.create({
              language: 'python',
              autoStopInterval: 5,
            });

            try {
              const response = await sandbox.process.executeCommand(
                command,
                workDir,
                undefined,
                Math.ceil(timeoutMs / 1000),
              );
              return {
                success: response.exitCode === 0,
                output: formatCodeResult(response.result, response.exitCode),
                exitCode: response.exitCode,
              };
            } finally {
              await sandbox.delete().catch((err) => {
                logger.warn({ err, sandboxId: sandbox.id }, '[Daytona] Failed to delete sandbox');
              });
            }
          } catch (error) {
            return toToolError(this.id, error);
          }
        },
      }),

      create_sandbox: tool({
        description:
          'Create a persistent Daytona sandbox for multi-step operations. ' +
          'Returns a sandbox ID that can be used with other sandbox tools. ' +
          'Remember to delete the sandbox when done.',
        inputSchema: z.object({
          name: z.string().optional().describe('Optional name for the sandbox'),
          language: z
            .enum(['python', 'typescript', 'javascript'])
            .optional()
            .describe('Programming language (default: python)'),
        }),
        execute: async ({
          name,
          language,
        }: {
          name?: string;
          language?: SandboxLanguage;
        }) => {
          try {
            const daytona = getDaytona();
            const sandbox = await daytona.create({
              name,
              language: language || DEFAULT_LANGUAGE,
              autoStopInterval: 15,
            });

            this.activeSandboxes.set(sandbox.id, sandbox);

            return {
              sandboxId: sandbox.id,
              language: language || DEFAULT_LANGUAGE,
              message: `Sandbox created. Use sandbox_id "${sandbox.id}" for subsequent operations.`,
            };
          } catch (error) {
            return toToolError(this.id, error);
          }
        },
      }),

      sandbox_run_code: tool({
        description: 'Run code in an existing sandbox (created with create_sandbox)',
        inputSchema: z.object({
          sandboxId: z.string().describe('The sandbox ID from create_sandbox'),
          code: z.string().describe('The code to execute'),
          timeout: z
            .number()
            .int()
            .min(1000)
            .max(300000)
            .optional()
            .describe('Timeout in milliseconds (default: 30000)'),
        }),
        execute: async ({
          sandboxId,
          code,
          timeout,
        }: {
          sandboxId: string;
          code: string;
          timeout?: number;
        }) => {
          const timeoutMs = timeout || SANDBOX_TIMEOUT_MS;
          const sandbox = this.activeSandboxes.get(sandboxId);

          if (!sandbox) {
            return createToolError(this.id, `Sandbox "${sandboxId}" not found. Create one first.`, {
              kind: 'invalid_request',
            });
          }

          try {
            const response = await sandbox.process.codeRun(code, undefined, timeoutMs);
            return {
              success: response.exitCode === 0,
              output: formatCodeResult(response.result, response.exitCode),
              exitCode: response.exitCode,
            };
          } catch (error) {
            return toToolError(this.id, error);
          }
        },
      }),

      sandbox_upload_file: tool({
        description: 'Upload a file to an existing sandbox',
        inputSchema: z.object({
          sandboxId: z.string().describe('The sandbox ID from create_sandbox'),
          content: z.string().describe('File content (text)'),
          path: z.string().describe('Destination path in the sandbox'),
        }),
        execute: async ({
          sandboxId,
          content,
          path,
        }: {
          sandboxId: string;
          content: string;
          path: string;
        }) => {
          const sandbox = this.activeSandboxes.get(sandboxId);

          if (!sandbox) {
            return createToolError(this.id, `Sandbox "${sandboxId}" not found. Create one first.`, {
              kind: 'invalid_request',
            });
          }

          try {
            await sandbox.fs.uploadFile(Buffer.from(content, 'utf-8'), path);
            return {
              success: true,
              path,
              message: `File uploaded to ${path}`,
            };
          } catch (error) {
            return toToolError(this.id, error);
          }
        },
      }),

      sandbox_download_file: tool({
        description: 'Download a file from an existing sandbox',
        inputSchema: z.object({
          sandboxId: z.string().describe('The sandbox ID from create_sandbox'),
          path: z.string().describe('Path to the file in the sandbox'),
        }),
        execute: async ({ sandboxId, path }: { sandboxId: string; path: string }) => {
          const sandbox = this.activeSandboxes.get(sandboxId);

          if (!sandbox) {
            return createToolError(this.id, `Sandbox "${sandboxId}" not found. Create one first.`, {
              kind: 'invalid_request',
            });
          }

          try {
            const content = await sandbox.fs.downloadFile(path);
            return {
              success: true,
              path,
              content: content.toString('utf-8'),
            };
          } catch (error) {
            return toToolError(this.id, error);
          }
        },
      }),

      sandbox_list_files: tool({
        description: 'List files and directories in a sandbox',
        inputSchema: z.object({
          sandboxId: z.string().describe('The sandbox ID from create_sandbox'),
          path: z.string().optional().describe('Directory path (default: home directory)'),
        }),
        execute: async ({ sandboxId, path }: { sandboxId: string; path?: string }) => {
          const sandbox = this.activeSandboxes.get(sandboxId);

          if (!sandbox) {
            return createToolError(this.id, `Sandbox "${sandboxId}" not found. Create one first.`, {
              kind: 'invalid_request',
            });
          }

          try {
            const files = await sandbox.fs.listFiles(path || '.');
            return {
              success: true,
              path: path || '.',
              files: files.map((f) => ({
                name: f.name,
                isDirectory: f.isDir,
                size: f.size,
              })),
            };
          } catch (error) {
            return toToolError(this.id, error);
          }
        },
      }),

      delete_sandbox: tool({
        description: 'Delete a sandbox when you are done with it',
        inputSchema: z.object({
          sandboxId: z.string().describe('The sandbox ID to delete'),
        }),
        execute: async ({ sandboxId }: { sandboxId: string }) => {
          const sandbox = this.activeSandboxes.get(sandboxId);

          if (!sandbox) {
            return createToolError(this.id, `Sandbox "${sandboxId}" not found.`, {
              kind: 'invalid_request',
            });
          }

          try {
            await sandbox.delete();
            this.activeSandboxes.delete(sandboxId);
            return {
              success: true,
              message: `Sandbox "${sandboxId}" deleted.`,
            };
          } catch (error) {
            this.activeSandboxes.delete(sandboxId);
            return toToolError(this.id, error);
          }
        },
      }),
    };
  }
}
