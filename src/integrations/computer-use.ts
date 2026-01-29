import { tool } from 'ai';
import type { ToolSet } from 'ai';
import { Daytona, type Sandbox } from '@daytonaio/sdk';
import { z } from 'zod';
import { BaseIntegration } from './base.js';
import { loadConfig } from '../lib/config.js';
import { createToolError, toToolError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

const INTEGRATION_ID = 'computer_use';
const DEFAULT_AUTO_STOP_MINUTES = 15;
const DEFAULT_AUTO_DELETE_MINUTES = 60;
const DEFAULT_COMMAND_TIMEOUT_SECONDS = 60;

type MouseButton = 'left' | 'right' | 'middle';
type ScrollDirection = 'up' | 'down';

interface DaytonaConfig {
  apiKey?: string;
  apiUrl?: string;
  target?: string;
}

interface ScreenshotRegion {
  x: number;
  y: number;
  width: number;
  height: number;
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
    throw new Error('DAYTONA_API_KEY is required for computer use');
  }
  return new Daytona({
    apiKey: config.apiKey,
    apiUrl: config.apiUrl,
    target: config.target,
  });
};

const sessionIdSchema = z.string().min(1).describe('Computer use session ID');

export class ComputerUseIntegration extends BaseIntegration {
  id = INTEGRATION_ID;
  name = 'Computer Use';
  description = 'Visual UI automation using Daytona desktop environments';

  private sessions = new Map<string, Sandbox>();

  isEnabled(): boolean {
    const config = getDaytonaConfig();
    return !!config.apiKey;
  }

  getTools(): ToolSet {
    return {
      start_session: tool({
        description: 'Start a Daytona desktop session for UI automation',
        inputSchema: z.object({
          name: z.string().optional().describe('Optional session name'),
          autoStopMinutes: z.number().int().min(1).max(120).optional().describe('Auto-stop timeout in minutes'),
          autoDeleteMinutes: z.number().int().min(5).max(240).optional().describe('Auto-delete timeout in minutes'),
        }),
        execute: async ({ name, autoStopMinutes, autoDeleteMinutes }: {
          name?: string;
          autoStopMinutes?: number;
          autoDeleteMinutes?: number;
        }) => {
          try {
            const daytona = getDaytona();
            const sandbox = await daytona.create({
              name,
              language: 'python',
              autoStopInterval: autoStopMinutes ?? DEFAULT_AUTO_STOP_MINUTES,
              autoDeleteInterval: autoDeleteMinutes ?? DEFAULT_AUTO_DELETE_MINUTES,
            });

            await sandbox.computerUse.start();
            this.sessions.set(sandbox.id, sandbox);

            return {
              success: true,
              sessionId: sandbox.id,
              message: 'Computer use session started',
            };
          } catch (error) {
            return toToolError(INTEGRATION_ID, error);
          }
        },
      }),

      stop_session: tool({
        description: 'Stop and delete a computer use session',
        inputSchema: z.object({
          sessionId: sessionIdSchema,
          deleteSandbox: z.boolean().optional().describe('Delete the sandbox after stopping (default true)'),
        }),
        execute: async ({ sessionId, deleteSandbox }: { sessionId: string; deleteSandbox?: boolean }) => {
          const sandbox = this.sessions.get(sessionId);
          if (!sandbox) {
            return createToolError(INTEGRATION_ID, `Session "${sessionId}" not found`, {
              hint: 'Use computer_use_start_session to create one.',
            });
          }

          try {
            await sandbox.computerUse.stop().catch((err) => {
              logger.warn({ err, sessionId }, '[ComputerUse] Failed to stop computer use processes');
            });

            if (deleteSandbox !== false) {
              await sandbox.delete().catch((err) => {
                logger.warn({ err, sessionId }, '[ComputerUse] Failed to delete sandbox');
              });
            }

            this.sessions.delete(sessionId);

            return { success: true, message: 'Session stopped' };
          } catch (error) {
            return toToolError(INTEGRATION_ID, error);
          }
        },
      }),

      take_screenshot: tool({
        description: 'Capture a screenshot of the desktop session',
        inputSchema: z.object({
          sessionId: sessionIdSchema,
          region: z
            .object({
              x: z.number().int().min(0),
              y: z.number().int().min(0),
              width: z.number().int().min(1),
              height: z.number().int().min(1),
            })
            .optional()
            .describe('Optional region to capture'),
          showCursor: z.boolean().optional().describe('Include cursor in screenshot'),
          format: z.enum(['png', 'jpeg', 'webp']).optional().describe('Image format (compressed screenshot)'),
          quality: z.number().int().min(10).max(100).optional().describe('Image quality (for jpeg/webp)'),
          scale: z.number().min(0.1).max(1).optional().describe('Scale factor for the screenshot'),
        }),
        execute: async ({ sessionId, region, showCursor, format, quality, scale }: {
          sessionId: string;
          region?: ScreenshotRegion;
          showCursor?: boolean;
          format?: 'png' | 'jpeg' | 'webp';
          quality?: number;
          scale?: number;
        }) => {
          const sandbox = this.sessions.get(sessionId);
          if (!sandbox) {
            return createToolError(INTEGRATION_ID, `Session "${sessionId}" not found`, {
              hint: 'Use computer_use_start_session to create one.',
            });
          }

          try {
            const useCompressed = !!format || !!quality || !!scale;
            const options = { showCursor, format, quality, scale };

            const result = region
              ? (useCompressed
                ? await sandbox.computerUse.screenshot.takeCompressedRegion(region, options)
                : await sandbox.computerUse.screenshot.takeRegion(region, showCursor))
              : (useCompressed
                ? await sandbox.computerUse.screenshot.takeCompressed(options)
                : await sandbox.computerUse.screenshot.takeFullScreen(showCursor));

            return {
              success: true,
              imageBase64: result.screenshot,
              sizeBytes: result.sizeBytes,
              region: region ?? null,
              cursorPosition: result.cursorPosition ?? null,
            };
          } catch (error) {
            return toToolError(INTEGRATION_ID, error);
          }
        },
      }),

      click: tool({
        description: 'Click at a coordinate on the desktop',
        inputSchema: z.object({
          sessionId: sessionIdSchema,
          x: z.number().int().min(0).describe('X coordinate'),
          y: z.number().int().min(0).describe('Y coordinate'),
          button: z.enum(['left', 'right', 'middle']).optional().describe('Mouse button'),
          double: z.boolean().optional().describe('Perform a double click'),
        }),
        execute: async ({ sessionId, x, y, button, double }: {
          sessionId: string;
          x: number;
          y: number;
          button?: MouseButton;
          double?: boolean;
        }) => {
          const sandbox = this.sessions.get(sessionId);
          if (!sandbox) {
            return createToolError(INTEGRATION_ID, `Session "${sessionId}" not found`, {
              hint: 'Use computer_use_start_session to create one.',
            });
          }

          try {
            const result = await sandbox.computerUse.mouse.click(x, y, button, double);
            return {
              success: true,
              action: 'click',
              x: result.x ?? x,
              y: result.y ?? y,
              button: button ?? 'left',
              double: double ?? false,
            };
          } catch (error) {
            return toToolError(INTEGRATION_ID, error);
          }
        },
      }),

      type_text: tool({
        description: 'Type text into the active application',
        inputSchema: z.object({
          sessionId: sessionIdSchema,
          text: z.string().min(1).describe('Text to type'),
          delayMs: z.number().int().min(0).max(1000).optional().describe('Delay between keystrokes in ms'),
        }),
        execute: async ({ sessionId, text, delayMs }: {
          sessionId: string;
          text: string;
          delayMs?: number;
        }) => {
          const sandbox = this.sessions.get(sessionId);
          if (!sandbox) {
            return createToolError(INTEGRATION_ID, `Session "${sessionId}" not found`, {
              hint: 'Use computer_use_start_session to create one.',
            });
          }

          try {
            await sandbox.computerUse.keyboard.type(text, delayMs);
            return { success: true, action: 'type', textLength: text.length };
          } catch (error) {
            return toToolError(INTEGRATION_ID, error);
          }
        },
      }),

      press_key: tool({
        description: 'Press a keyboard key with optional modifiers',
        inputSchema: z.object({
          sessionId: sessionIdSchema,
          key: z.string().min(1).describe('Key to press (e.g., Enter, Tab, a)'),
          modifiers: z.array(z.enum(['ctrl', 'alt', 'shift', 'meta'])).optional().describe('Modifier keys'),
        }),
        execute: async ({ sessionId, key, modifiers }: {
          sessionId: string;
          key: string;
          modifiers?: Array<'ctrl' | 'alt' | 'shift' | 'meta'>;
        }) => {
          const sandbox = this.sessions.get(sessionId);
          if (!sandbox) {
            return createToolError(INTEGRATION_ID, `Session "${sessionId}" not found`, {
              hint: 'Use computer_use_start_session to create one.',
            });
          }

          try {
            await sandbox.computerUse.keyboard.press(key, modifiers);
            return { success: true, action: 'press_key', key };
          } catch (error) {
            return toToolError(INTEGRATION_ID, error);
          }
        },
      }),

      scroll: tool({
        description: 'Scroll at a coordinate on the desktop',
        inputSchema: z.object({
          sessionId: sessionIdSchema,
          x: z.number().int().min(0).describe('X coordinate'),
          y: z.number().int().min(0).describe('Y coordinate'),
          direction: z.enum(['up', 'down']).describe('Scroll direction'),
          amount: z.number().int().min(1).max(10).optional().describe('Scroll amount'),
        }),
        execute: async ({ sessionId, x, y, direction, amount }: {
          sessionId: string;
          x: number;
          y: number;
          direction: ScrollDirection;
          amount?: number;
        }) => {
          const sandbox = this.sessions.get(sessionId);
          if (!sandbox) {
            return createToolError(INTEGRATION_ID, `Session "${sessionId}" not found`, {
              hint: 'Use computer_use_start_session to create one.',
            });
          }

          try {
            const success = await sandbox.computerUse.mouse.scroll(x, y, direction, amount);
            return { success, action: 'scroll', direction, amount: amount ?? 1 };
          } catch (error) {
            return toToolError(INTEGRATION_ID, error);
          }
        },
      }),

      list_windows: tool({
        description: 'List open windows in the desktop session',
        inputSchema: z.object({
          sessionId: sessionIdSchema,
        }),
        execute: async ({ sessionId }: { sessionId: string }) => {
          const sandbox = this.sessions.get(sessionId);
          if (!sandbox) {
            return createToolError(INTEGRATION_ID, `Session "${sessionId}" not found`, {
              hint: 'Use computer_use_start_session to create one.',
            });
          }

          try {
            const windows = await sandbox.computerUse.display.getWindows();
            return {
              success: true,
              count: windows.windows?.length ?? 0,
              windows: windows.windows,
            };
          } catch (error) {
            return toToolError(INTEGRATION_ID, error);
          }
        },
      }),

      get_display_info: tool({
        description: 'Get display information for the desktop session',
        inputSchema: z.object({
          sessionId: sessionIdSchema,
        }),
        execute: async ({ sessionId }: { sessionId: string }) => {
          const sandbox = this.sessions.get(sessionId);
          if (!sandbox) {
            return createToolError(INTEGRATION_ID, `Session "${sessionId}" not found`, {
              hint: 'Use computer_use_start_session to create one.',
            });
          }

          try {
            const info = await sandbox.computerUse.display.getInfo();
            return { success: true, info };
          } catch (error) {
            return toToolError(INTEGRATION_ID, error);
          }
        },
      }),

      open_app: tool({
        description: 'Run a command in the desktop session (use to launch apps)',
        inputSchema: z.object({
          sessionId: sessionIdSchema,
          command: z.string().min(1).describe('Command to run'),
          args: z.array(z.string()).optional().describe('Command arguments'),
          workDir: z.string().optional().describe('Working directory'),
        }),
        execute: async ({ sessionId, command, args, workDir }: {
          sessionId: string;
          command: string;
          args?: string[];
          workDir?: string;
        }) => {
          const sandbox = this.sessions.get(sessionId);
          if (!sandbox) {
            return createToolError(INTEGRATION_ID, `Session "${sessionId}" not found`, {
              hint: 'Use computer_use_start_session to create one.',
            });
          }

          try {
            const cmd = args && args.length > 0 ? `${command} ${args.join(' ')}` : command;
            const result = await sandbox.process.executeCommand(
              cmd,
              workDir,
              undefined,
              DEFAULT_COMMAND_TIMEOUT_SECONDS,
            );

            return {
              success: result.exitCode === 0,
              command: cmd,
              exitCode: result.exitCode,
              output: result.result,
            };
          } catch (error) {
            return toToolError(INTEGRATION_ID, error);
          }
        },
      }),
    };
  }
}
