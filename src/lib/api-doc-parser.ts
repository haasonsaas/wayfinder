

export interface ParsedEndpoint {
  path: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  operationId?: string;
  summary?: string;
  description?: string;
  parameters: ParsedParameter[];
  requestBody?: ParsedRequestBody;
  responses: Record<string, ParsedResponse>;
  security?: string[];
  tags?: string[];
}

export interface ParsedParameter {
  name: string;
  in: 'query' | 'path' | 'header' | 'cookie';
  required: boolean;
  description?: string;
  schema: SchemaObject;
}

export interface ParsedRequestBody {
  required: boolean;
  description?: string;
  content: Record<string, { schema: SchemaObject }>;
}

export interface ParsedResponse {
  description: string;
  content?: Record<string, { schema: SchemaObject }>;
}

export interface SchemaObject {
  type?: string;
  format?: string;
  description?: string;
  properties?: Record<string, SchemaObject>;
  items?: SchemaObject;
  required?: string[];
  enum?: unknown[];
  default?: unknown;
  example?: unknown;
  $ref?: string;
}

export interface ParsedApiSpec {
  title: string;
  version: string;
  description?: string;
  baseUrl: string;
  authMethods: AuthMethod[];
  endpoints: ParsedEndpoint[];
  schemas: Record<string, SchemaObject>;
}

export interface AuthMethod {
  type: 'apiKey' | 'http' | 'oauth2' | 'openIdConnect';
  name?: string;
  in?: 'header' | 'query' | 'cookie';
  scheme?: string;
  bearerFormat?: string;
}

export interface GeneratedToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  endpoint: string;
  method: string;
  pathParams: string[];
  queryParams: string[];
  bodySchema?: Record<string, unknown>;
  authType?: string;
}

export class ApiDocParser {
  async parse(input: string | object): Promise<ParsedApiSpec> {
    const spec = typeof input === 'string' ? JSON.parse(input) : input;

    if (spec.openapi?.startsWith('3.')) {
      return this.parseOpenApi3(spec);
    } else if (spec.swagger === '2.0') {
      return this.parseSwagger2(spec);
    }

    throw new Error('Unsupported API specification format. Expected OpenAPI 3.x or Swagger 2.0');
  }

  async fetchAndParse(url: string): Promise<ParsedApiSpec> {
    const response = await fetch(url, {
      headers: { Accept: 'application/json, application/yaml, text/yaml' },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch API spec: ${response.status} ${response.statusText}`);
    }

    const text = await response.text();
    
    let spec: object;
    try {
      spec = JSON.parse(text);
    } catch {
      const yaml = await import('yaml') as { parse: (text: string) => object };
      spec = yaml.parse(text);
    }

    return this.parse(spec);
  }

  private parseOpenApi3(spec: Record<string, unknown>): ParsedApiSpec {
    const info = spec.info as Record<string, unknown> || {};
    const servers = (spec.servers as Array<{ url: string }>) || [];
    const paths = (spec.paths as Record<string, Record<string, unknown>>) || {};
    const components = (spec.components as Record<string, unknown>) || {};
    const securitySchemes = (components.securitySchemes as Record<string, unknown>) || {};
    const schemas = (components.schemas as Record<string, SchemaObject>) || {};

    const baseUrl = servers[0]?.url || '';
    const authMethods = this.parseSecuritySchemes(securitySchemes);
    const endpoints = this.parseOpenApi3Paths(paths);

    return {
      title: String(info.title || 'Unknown API'),
      version: String(info.version || '1.0.0'),
      description: info.description as string | undefined,
      baseUrl,
      authMethods,
      endpoints,
      schemas,
    };
  }

  private parseSwagger2(spec: Record<string, unknown>): ParsedApiSpec {
    const info = spec.info as Record<string, unknown> || {};
    const host = spec.host as string || '';
    const basePath = spec.basePath as string || '';
    const schemes = (spec.schemes as string[]) || ['https'];
    const paths = (spec.paths as Record<string, Record<string, unknown>>) || {};
    const securityDefinitions = (spec.securityDefinitions as Record<string, unknown>) || {};
    const definitions = (spec.definitions as Record<string, SchemaObject>) || {};

    const baseUrl = `${schemes[0]}://${host}${basePath}`;
    const authMethods = this.parseSecuritySchemes(securityDefinitions);
    const endpoints = this.parseSwagger2Paths(paths);

    return {
      title: String(info.title || 'Unknown API'),
      version: String(info.version || '1.0.0'),
      description: info.description as string | undefined,
      baseUrl,
      authMethods,
      endpoints,
      schemas: definitions,
    };
  }

  private parseSecuritySchemes(schemes: Record<string, unknown>): AuthMethod[] {
    const methods: AuthMethod[] = [];

    for (const [, scheme] of Object.entries(schemes)) {
      const s = scheme as Record<string, unknown>;
      const type = s.type as string;

      if (type === 'apiKey') {
        methods.push({
          type: 'apiKey',
          name: s.name as string,
          in: s.in as 'header' | 'query' | 'cookie',
        });
      } else if (type === 'http') {
        methods.push({
          type: 'http',
          scheme: s.scheme as string,
          bearerFormat: s.bearerFormat as string | undefined,
        });
      } else if (type === 'oauth2') {
        methods.push({ type: 'oauth2' });
      }
    }

    return methods;
  }

  private parseOpenApi3Paths(paths: Record<string, Record<string, unknown>>): ParsedEndpoint[] {
    const endpoints: ParsedEndpoint[] = [];

    for (const [path, methods] of Object.entries(paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        if (!['get', 'post', 'put', 'delete', 'patch'].includes(method)) continue;

        const op = operation as Record<string, unknown>;
        const parameters = this.parseParameters(op.parameters as Array<Record<string, unknown>> || []);
        const requestBody = op.requestBody ? this.parseRequestBody(op.requestBody as Record<string, unknown>) : undefined;

        endpoints.push({
          path,
          method: method.toUpperCase() as ParsedEndpoint['method'],
          operationId: op.operationId as string | undefined,
          summary: op.summary as string | undefined,
          description: op.description as string | undefined,
          parameters,
          requestBody,
          responses: this.parseResponses(op.responses as Record<string, unknown> || {}),
          security: op.security as string[] | undefined,
          tags: op.tags as string[] | undefined,
        });
      }
    }

    return endpoints;
  }

  private parseSwagger2Paths(paths: Record<string, Record<string, unknown>>): ParsedEndpoint[] {
    const endpoints: ParsedEndpoint[] = [];

    for (const [path, methods] of Object.entries(paths)) {
      for (const [method, operation] of Object.entries(methods)) {
        if (!['get', 'post', 'put', 'delete', 'patch'].includes(method)) continue;

        const op = operation as Record<string, unknown>;
        const allParams = op.parameters as Array<Record<string, unknown>> || [];
        
        const bodyParam = allParams.find((p) => p.in === 'body');
        const otherParams = allParams.filter((p) => p.in !== 'body');

        endpoints.push({
          path,
          method: method.toUpperCase() as ParsedEndpoint['method'],
          operationId: op.operationId as string | undefined,
          summary: op.summary as string | undefined,
          description: op.description as string | undefined,
          parameters: this.parseParameters(otherParams),
          requestBody: bodyParam ? {
            required: bodyParam.required as boolean || false,
            description: bodyParam.description as string | undefined,
            content: { 'application/json': { schema: bodyParam.schema as SchemaObject || {} } },
          } : undefined,
          responses: this.parseResponses(op.responses as Record<string, unknown> || {}),
          tags: op.tags as string[] | undefined,
        });
      }
    }

    return endpoints;
  }

  private parseParameters(params: Array<Record<string, unknown>>): ParsedParameter[] {
    return params.map((p) => ({
      name: p.name as string,
      in: p.in as ParsedParameter['in'],
      required: p.required as boolean || false,
      description: p.description as string | undefined,
      schema: (p.schema as SchemaObject) || { type: p.type as string },
    }));
  }

  private parseRequestBody(body: Record<string, unknown>): ParsedRequestBody {
    const content = body.content as Record<string, { schema: SchemaObject }> || {};
    return {
      required: body.required as boolean || false,
      description: body.description as string | undefined,
      content,
    };
  }

  private parseResponses(responses: Record<string, unknown>): Record<string, ParsedResponse> {
    const parsed: Record<string, ParsedResponse> = {};

    for (const [code, response] of Object.entries(responses)) {
      const r = response as Record<string, unknown>;
      parsed[code] = {
        description: r.description as string || '',
        content: r.content as Record<string, { schema: SchemaObject }> | undefined,
      };
    }

    return parsed;
  }

  generateToolSchemas(spec: ParsedApiSpec, options: { maxTools?: number } = {}): GeneratedToolSchema[] {
    const tools: GeneratedToolSchema[] = [];
    const maxTools = options.maxTools || 50;

    for (const endpoint of spec.endpoints.slice(0, maxTools)) {
      const name = this.generateToolName(endpoint);
      const description = endpoint.summary || endpoint.description || `${endpoint.method} ${endpoint.path}`;

      const pathParams = endpoint.parameters.filter((p) => p.in === 'path').map((p) => p.name);
      const queryParams = endpoint.parameters.filter((p) => p.in === 'query').map((p) => p.name);

      const inputSchema: Record<string, unknown> = {};

      for (const param of endpoint.parameters) {
        inputSchema[param.name] = {
          type: param.schema.type || 'string',
          description: param.description,
          required: param.required,
        };
      }

      if (endpoint.requestBody) {
        const jsonContent = endpoint.requestBody.content['application/json'];
        if (jsonContent?.schema) {
          const bodySchema = this.flattenSchema(jsonContent.schema, spec.schemas);
          for (const [key, value] of Object.entries(bodySchema)) {
            inputSchema[key] = value;
          }
        }
      }

      const fullUrl = `${spec.baseUrl}${endpoint.path}`;

      tools.push({
        name,
        description: description.slice(0, 500),
        inputSchema,
        endpoint: fullUrl,
        method: endpoint.method,
        pathParams,
        queryParams,
        authType: spec.authMethods[0]?.type,
      });
    }

    return tools;
  }

  private generateToolName(endpoint: ParsedEndpoint): string {
    if (endpoint.operationId) {
      return endpoint.operationId.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
    }

    const pathParts = endpoint.path
      .split('/')
      .filter((p) => p && !p.startsWith('{'))
      .slice(-2);

    return `${endpoint.method.toLowerCase()}_${pathParts.join('_')}`.replace(/[^a-z0-9_]/g, '');
  }

  private flattenSchema(schema: SchemaObject, allSchemas: Record<string, SchemaObject>, depth = 0): Record<string, unknown> {
    if (depth > 3) return {};

    if (schema.$ref) {
      const refName = schema.$ref.split('/').pop();
      if (refName && allSchemas[refName]) {
        return this.flattenSchema(allSchemas[refName], allSchemas, depth + 1);
      }
      return {};
    }

    if (schema.properties) {
      const result: Record<string, unknown> = {};
      for (const [key, prop] of Object.entries(schema.properties)) {
        result[key] = {
          type: prop.type || 'string',
          description: prop.description,
          required: schema.required?.includes(key) || false,
        };
      }
      return result;
    }

    return {};
  }
}

export const apiDocParser = new ApiDocParser();
