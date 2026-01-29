import { tool } from 'ai';
import type { ToolExecutionOptions, ToolSet } from 'ai';
import { z } from 'zod';
import { BaseIntegration } from './base.js';
import { createToolError, toToolError } from '../lib/errors.js';
import { apiDocParser, type GeneratedToolSchema } from '../lib/api-doc-parser.js';
import { toolStorage, type StoredTool } from '../lib/tool-storage.js';
import { dynamicToolExecutor } from '../lib/dynamic-tool-executor.js';
import { toolRegistry } from '../lib/tool-registry.js';
import { logger } from '../lib/logger.js';

const INTEGRATION_ID = 'meta_tool_builder';

const apiDocInputSchema = z.object({
  url: z.string().url().describe('URL to the API documentation (OpenAPI/Swagger spec)'),
  format: z.enum(['openapi', 'swagger', 'auto']).optional().describe('Format hint'),
});

const manualParameterSchema = z.object({
  type: z.enum(['string', 'number', 'boolean', 'array', 'object']),
  description: z.string().optional(),
  required: z.boolean().optional(),
  in: z.enum(['query', 'path', 'body']).optional(),
});

const generateToolSchemaInput = z.object({
  name: z.string().min(1).max(64).regex(/^[a-z][a-z0-9_]*$/).describe('Tool name (lowercase, underscores)'),
  description: z.string().min(1).max(500).describe('What the tool does'),
  endpoint: z.string().url().optional().describe('API endpoint URL'),
  method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']).optional().describe('HTTP method'),
  parameters: z.record(manualParameterSchema).optional().describe('Input parameters'),
  authType: z.enum(['none', 'api_key', 'bearer', 'basic']).optional(),
});

const createToolInputSchema = z.object({
  name: z.string().describe('Tool name'),
  description: z.string().describe('Tool description'),
  endpoint: z.string().url().describe('API endpoint'),
  method: z.enum(['GET', 'POST', 'PUT', 'DELETE', 'PATCH']).describe('HTTP method'),
  inputSchema: z.record(z.unknown()).describe('Input parameters schema'),
  pathParams: z.array(z.string()).optional(),
  queryParams: z.array(z.string()).optional(),
  authType: z.string().optional(),
  testFirst: z.boolean().optional().describe('Test the tool before saving'),
  isPublic: z.boolean().optional().describe('Make tool available to all users'),
  tags: z.array(z.string()).optional(),
});

const testToolInputSchema = z.object({
  toolName: z.string().describe('Name of the tool to test'),
  testInputs: z.record(z.unknown()).describe('Test input values'),
});

const listToolsInputSchema = z.object({
  source: z.enum(['manual', 'api_doc', 'generated']).optional(),
  tags: z.array(z.string()).optional(),
});

const deleteToolInputSchema = z.object({
  toolName: z.string().describe('Name of the tool to delete'),
});

const generateFromApiInputSchema = z.object({
  url: z.string().url().describe('URL to the API documentation'),
  maxTools: z.number().int().min(1).max(50).optional().describe('Maximum tools to generate'),
  filterTags: z.array(z.string()).optional().describe('Only generate tools with these tags'),
});

type ApiDocInput = z.infer<typeof apiDocInputSchema>;
type GenerateToolSchemaInput = z.infer<typeof generateToolSchemaInput>;
type CreateToolInput = z.infer<typeof createToolInputSchema>;
type TestToolInput = z.infer<typeof testToolInputSchema>;
type ListToolsInput = z.infer<typeof listToolsInputSchema>;
type DeleteToolInput = z.infer<typeof deleteToolInputSchema>;
type GenerateFromApiInput = z.infer<typeof generateFromApiInputSchema>;

interface ToolContext {
  userId?: string;
  workspaceId?: string;
}

const resolveToolContext = (context?: ToolExecutionOptions): ToolContext => {
  const meta = context?.experimental_context as
    | { userId?: string; workspaceId?: string; teamId?: string }
    | undefined;

  if (!meta) {
    return {};
  }

  return {
    userId: meta.userId,
    workspaceId: meta.workspaceId ?? meta.teamId,
  };
};

const canAccessTool = (tool: StoredTool, context: ToolContext): boolean => {
  if (tool.isPublic) return true;
  if (context.userId && tool.createdBy === context.userId) return true;
  if (context.workspaceId && tool.workspaceId === context.workspaceId) return true;
  return false;
};

export class MetaToolBuilderIntegration extends BaseIntegration {
  id = INTEGRATION_ID;
  name = 'Meta Tool Builder';
  description = 'Create and manage custom tools at runtime from API docs or descriptions';

  isEnabled(): boolean {
    return true;
  }

  getTools(): ToolSet {
    return {
      fetch_api_docs: tool({
        description: 'Fetch and parse API documentation from a URL (OpenAPI/Swagger)',
        inputSchema: apiDocInputSchema,
        execute: async ({ url, format }: ApiDocInput) => {
          try {
            const spec = await apiDocParser.fetchAndParse(url);
            const formatHint = format ?? 'auto';

            return {
              title: spec.title,
              version: spec.version,
              description: spec.description,
              baseUrl: spec.baseUrl,
              authMethods: spec.authMethods,
              endpointCount: spec.endpoints.length,
              format: formatHint,
              endpoints: spec.endpoints.slice(0, 20).map((endpoint) => ({
                path: endpoint.path,
                method: endpoint.method,
                summary: endpoint.summary || endpoint.description?.slice(0, 100),
                operationId: endpoint.operationId,
              })),
            };
          } catch (error) {
            return toToolError(INTEGRATION_ID, error);
          }
        },
      }),

      generate_tool_schema: tool({
        description: 'Generate a tool definition from API docs URL or a natural language description',
        inputSchema: generateToolSchemaInput,
        execute: async ({ name, description, endpoint, method, parameters, authType }: GenerateToolSchemaInput) => {
          try {
            const pathParams: string[] = [];
            const queryParams: string[] = [];
            const inputSchema: Record<string, unknown> = {};

            if (parameters) {
              for (const [key, param] of Object.entries(parameters)) {
                inputSchema[key] = {
                  type: param.type,
                  description: param.description,
                  required: param.required ?? false,
                };

                if (param.in === 'path') {
                  pathParams.push(key);
                } else if (param.in === 'query') {
                  queryParams.push(key);
                }
              }
            }

            const toolSchema: GeneratedToolSchema = {
              name,
              description,
              inputSchema,
              endpoint: endpoint || '',
              method: method || 'GET',
              pathParams,
              queryParams,
              authType,
            };

            const validationErrors: string[] = [];

            if (!endpoint) {
              validationErrors.push('No endpoint URL provided - tool will need manual configuration');
            }

            if (endpoint) {
              try {
                const pathMatches = endpoint.match(/\{([^}]+)\}/g) || [];
                const declaredPathParams = pathMatches.map((match) => match.slice(1, -1));

                for (const param of declaredPathParams) {
                  if (!pathParams.includes(param)) {
                    validationErrors.push(`Path parameter "${param}" found in URL but not declared in parameters`);
                  }
                }
                new URL(endpoint);
              } catch {
                validationErrors.push('Invalid endpoint URL format');
              }
            }

            return {
              toolSchema,
              validationErrors: validationErrors.length > 0 ? validationErrors : undefined,
              preview: {
                name,
                description,
                method: method || 'GET',
                endpoint: endpoint || '(not set)',
                parameters: Object.keys(inputSchema),
                authType: authType || 'none',
              },
            };
          } catch (error) {
            return toToolError(INTEGRATION_ID, error);
          }
        },
      }),

      create_tool: tool({
        description: 'Register a new tool in the registry so it can be used',
        inputSchema: createToolInputSchema,
        execute: async (input: CreateToolInput, context: ToolExecutionOptions) => {
          try {
            const toolContext = resolveToolContext(context);
            const createdBy = toolContext.userId ?? 'system';
            const toolSchema: GeneratedToolSchema = {
              name: input.name,
              description: input.description,
              inputSchema: input.inputSchema,
              endpoint: input.endpoint,
              method: input.method,
              pathParams: input.pathParams || [],
              queryParams: input.queryParams || [],
              authType: input.authType,
            };

            if (input.testFirst) {
              const testResult = await dynamicToolExecutor.testTool(
                toolSchema,
                {},
                { userId: createdBy, workspaceId: toolContext.workspaceId },
              );

              if (!testResult.success && testResult.validationErrors?.length) {
                return createToolError(INTEGRATION_ID, 'Tool validation failed', {
                  hint: testResult.validationErrors.join('; '),
                });
              }
            }

            const stored = await toolStorage.save({
              ...toolSchema,
              createdBy,
              workspaceId: toolContext.workspaceId,
              isPublic: input.isPublic ?? false,
              source: 'manual',
              tags: input.tags,
            });

            await this.registerDynamicTool(stored);

            logger.info({ toolId: stored.id, name: stored.name }, '[MetaToolBuilder] Tool created');

            return {
              success: true,
              toolId: stored.id,
              name: stored.name,
              version: stored.version,
              message: `Tool "${stored.name}" created successfully. You can now use it.`,
            };
          } catch (error) {
            return toToolError(INTEGRATION_ID, error);
          }
        },
      }),

      test_tool: tool({
        description: 'Test a tool with sample inputs',
        inputSchema: testToolInputSchema,
        execute: async ({ toolName, testInputs }: TestToolInput, context: ToolExecutionOptions) => {
          try {
            const toolContext = resolveToolContext(context);
            const toolId = toolName.startsWith('tool_') ? toolName : `tool_${toolName}`;
            const stored = await toolStorage.get(toolId);

            if (!stored) {
              return createToolError(INTEGRATION_ID, `Tool "${toolName}" not found`, {
                hint: 'Use list_user_tools to see available tools',
              });
            }

            if (!canAccessTool(stored, toolContext)) {
              return createToolError(INTEGRATION_ID, `You do not have access to tool "${toolName}"`);
            }

            const result = await dynamicToolExecutor.testTool(
              stored,
              testInputs as Record<string, unknown>,
              { userId: toolContext.userId ?? 'system', workspaceId: toolContext.workspaceId },
            );

            return {
              success: result.success,
              tool: stored.name,
              response: result.response,
              validationErrors: result.validationErrors,
              duration: result.response?.duration,
            };
          } catch (error) {
            return toToolError(INTEGRATION_ID, error);
          }
        },
      }),

      list_user_tools: tool({
        description: 'List all user-created tools',
        inputSchema: listToolsInputSchema,
        execute: async ({ source, tags }: ListToolsInput, context: ToolExecutionOptions) => {
          try {
            const toolContext = resolveToolContext(context);
            const tools = await toolStorage.list({
              source,
              tags,
              userId: toolContext.userId,
              workspaceId: toolContext.workspaceId,
            });

            return {
              count: tools.length,
              tools: tools.map((t) => ({
                id: t.id,
                name: t.name,
                description: t.description.slice(0, 100),
                method: t.method,
                endpoint: t.endpoint,
                version: t.version,
                source: t.source,
                tags: t.tags,
                createdAt: t.createdAt,
              })),
            };
          } catch (error) {
            return toToolError(INTEGRATION_ID, error);
          }
        },
      }),

      delete_tool: tool({
        description: 'Delete a user-created tool',
        inputSchema: deleteToolInputSchema,
        execute: async ({ toolName }: DeleteToolInput, context: ToolExecutionOptions) => {
          try {
            const toolContext = resolveToolContext(context);
            const toolId = toolName.startsWith('tool_') ? toolName : `tool_${toolName}`;
            const stored = await toolStorage.get(toolId);

            if (!stored) {
              return createToolError(INTEGRATION_ID, `Tool "${toolName}" not found`);
            }

            if (!canAccessTool(stored, toolContext)) {
              return createToolError(INTEGRATION_ID, `You do not have access to tool "${toolName}"`);
            }

            const deleted = await toolStorage.delete(toolId);

            if (!deleted) {
              return createToolError(INTEGRATION_ID, `Tool "${toolName}" not found`);
            }

            return {
              success: true,
              message: `Tool "${toolName}" deleted successfully`,
            };
          } catch (error) {
            return toToolError(INTEGRATION_ID, error);
          }
        },
      }),

      generate_tools_from_api: tool({
        description: 'Generate multiple tools from an API documentation URL',
        inputSchema: generateFromApiInputSchema,
        execute: async ({ url, maxTools, filterTags }: GenerateFromApiInput, context: ToolExecutionOptions) => {
          try {
            const toolContext = resolveToolContext(context);
            const createdBy = toolContext.userId ?? 'system';
            const spec = await apiDocParser.fetchAndParse(url);

            let endpoints = spec.endpoints;
            if (filterTags && filterTags.length > 0) {
              endpoints = endpoints.filter((endpoint) =>
                endpoint.tags?.some((tag) => filterTags.includes(tag)),
              );
            }

            const tools = apiDocParser.generateToolSchemas(
              { ...spec, endpoints },
              { maxTools: maxTools || 20 },
            );

            const savedTools: string[] = [];
            const errors: string[] = [];

            for (const toolSchema of tools) {
              try {
                const stored = await toolStorage.save({
                  ...toolSchema,
                  createdBy,
                  workspaceId: toolContext.workspaceId,
                  isPublic: false,
                  source: 'api_doc',
                  sourceUrl: url,
                  tags: spec.title ? [spec.title.toLowerCase().replace(/\s+/g, '_')] : undefined,
                });

                await this.registerDynamicTool(stored);
                savedTools.push(stored.name);
              } catch (error) {
                errors.push(`${toolSchema.name}: ${error instanceof Error ? error.message : String(error)}`);
              }
            }

            return {
              apiTitle: spec.title,
              generated: savedTools.length,
              tools: savedTools,
              errors: errors.length > 0 ? errors : undefined,
            };
          } catch (error) {
            return toToolError(INTEGRATION_ID, error);
          }
        },
      }),
    };
  }

  private async registerDynamicTool(stored: StoredTool): Promise<void> {
    const inputSchema = this.buildZodSchema(stored.inputSchema);

    const dynamicTool = tool({
      description: stored.description,
      inputSchema,
      execute: async (input: Record<string, unknown>, context: ToolExecutionOptions) => {
        const toolContext = resolveToolContext(context);
        const result = await dynamicToolExecutor.execute(
          stored,
          input,
          { userId: toolContext.userId ?? 'runtime', workspaceId: toolContext.workspaceId },
        );

        if (!result.success) {
          return createToolError(stored.id, result.error || 'Request failed');
        }

        return result.data;
      },
    });

    await toolRegistry.registerTool(
      stored.id,
      'user_tools',
      dynamicTool,
      { isUserDefined: true, version: stored.version },
    );
  }

  async loadStoredTools(): Promise<void> {
    const tools = await toolStorage.listAll();
    for (const stored of tools) {
      await this.registerDynamicTool(stored);
    }

    logger.info({ count: tools.length }, '[MetaToolBuilder] Loaded stored tools');
  }

  private buildZodSchema(schema: Record<string, unknown>): z.ZodSchema {
    const shape: Record<string, z.ZodTypeAny> = {};

    for (const [key, value] of Object.entries(schema)) {
      if (typeof value === 'object' && value !== null) {
        const fieldDef = value as { type?: string; description?: string; required?: boolean };
        let zodType: z.ZodTypeAny;

        switch (fieldDef.type) {
          case 'string':
            zodType = z.string();
            break;
          case 'number':
            zodType = z.number();
            break;
          case 'boolean':
            zodType = z.boolean();
            break;
          case 'array':
            zodType = z.array(z.unknown());
            break;
          case 'object':
            zodType = z.record(z.unknown());
            break;
          default:
            zodType = z.unknown();
        }

        if (fieldDef.description) {
          zodType = zodType.describe(fieldDef.description);
        }

        if (!fieldDef.required) {
          zodType = zodType.optional();
        }

        shape[key] = zodType;
      }
    }

    return z.object(shape);
  }
}
