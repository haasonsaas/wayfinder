import { tool } from 'ai';
import snowflake from 'snowflake-sdk';
import { z } from 'zod';
import { BaseIntegration } from './base.js';
import { createToolError, toToolError } from '../lib/errors.js';
import { logger } from '../lib/logger.js';

interface SnowflakeConfig {
  account: string;
  username: string;
  password?: string;
  privateKey?: string;
  database?: string;
  schema?: string;
  warehouse?: string;
}

const getSnowflakeConfig = (): SnowflakeConfig | null => {
  const account = process.env.SNOWFLAKE_ACCOUNT;
  const username = process.env.SNOWFLAKE_USERNAME;
  const password = process.env.SNOWFLAKE_PASSWORD;
  const privateKey = process.env.SNOWFLAKE_PRIVATE_KEY;

  if (!account || !username || (!password && !privateKey)) {
    return null;
  }

  return {
    account,
    username,
    password,
    privateKey,
    database: process.env.SNOWFLAKE_DATABASE,
    schema: process.env.SNOWFLAKE_SCHEMA,
    warehouse: process.env.SNOWFLAKE_WAREHOUSE,
  };
};

const executeQuery = (
  connection: snowflake.Connection,
  sql: string,
  binds?: snowflake.Binds,
): Promise<unknown[]> => {
  return new Promise((resolve, reject) => {
    connection.execute({
      sqlText: sql,
      binds,
      complete: (err, _stmt, rows) => {
        if (err) {
          reject(err);
        } else {
          resolve(rows || []);
        }
      },
    });
  });
};

const getConnection = (): Promise<snowflake.Connection> => {
  return new Promise((resolve, reject) => {
    const config = getSnowflakeConfig();
    if (!config) {
      reject(new Error('Snowflake is not configured'));
      return;
    }

    const connectionOptions: snowflake.ConnectionOptions = {
      account: config.account,
      username: config.username,
      database: config.database,
      schema: config.schema,
      warehouse: config.warehouse,
    };

    if (config.password) {
      connectionOptions.password = config.password;
    } else if (config.privateKey) {
      connectionOptions.authenticator = 'SNOWFLAKE_JWT';
      connectionOptions.privateKey = config.privateKey;
    }

    const connection = snowflake.createConnection(connectionOptions);

    connection.connect((err, conn) => {
      if (err) {
        logger.error({ err }, '[Snowflake] Connection error');
        reject(err);
      } else {
        resolve(conn);
      }
    });
  });
};

const MAX_QUERY_ROWS = 1000;
const DANGEROUS_KEYWORDS = ['DROP', 'DELETE', 'TRUNCATE', 'ALTER', 'CREATE', 'INSERT', 'UPDATE', 'GRANT', 'REVOKE', 'MERGE'];

const isSafeQuery = (sql: string): { safe: boolean; reason?: string } => {
  const upperSql = sql.toUpperCase().trim();

  for (const keyword of DANGEROUS_KEYWORDS) {
    if (upperSql.startsWith(keyword) || new RegExp(`\\b${keyword}\\b`).test(upperSql)) {
      return { safe: false, reason: `Query contains restricted keyword: ${keyword}` };
    }
  }

  if (!upperSql.startsWith('SELECT') && !upperSql.startsWith('WITH') && !upperSql.startsWith('SHOW') && !upperSql.startsWith('DESCRIBE')) {
    return { safe: false, reason: 'Only SELECT, WITH (CTE), SHOW, and DESCRIBE queries are allowed' };
  }

  return { safe: true };
};

export class SnowflakeIntegration extends BaseIntegration {
  id = 'snowflake';
  name = 'Snowflake';
  description = 'Query Snowflake data warehouse with cross-database joins';
  icon = '❄️';

  isEnabled(): boolean {
    return getSnowflakeConfig() !== null;
  }

  getTools() {
    return {
      query: tool({
        description:
          'Execute a read-only SQL query against Snowflake. ' +
          'Only SELECT queries are allowed for safety. Results are limited to 1000 rows.',
        inputSchema: z.object({
          sql: z.string().describe('SQL query to execute (SELECT only)'),
          database: z.string().optional().describe('Database to use'),
          schema: z.string().optional().describe('Schema to use'),
          warehouse: z.string().optional().describe('Warehouse to use'),
        }),
        execute: async ({
          sql,
          database,
          schema,
          warehouse,
        }: {
          sql: string;
          database?: string;
          schema?: string;
          warehouse?: string;
        }) => {
          const safetyCheck = isSafeQuery(sql);
          if (!safetyCheck.safe) {
            return createToolError(this.id, safetyCheck.reason || 'Query not allowed', {
              kind: 'invalid_request',
              hint: 'Only SELECT queries are allowed for safety',
            });
          }

          try {
            const connection = await getConnection();

            // Set context if provided
            if (database) await executeQuery(connection, `USE DATABASE "${database}"`);
            if (schema) await executeQuery(connection, `USE SCHEMA "${schema}"`);
            if (warehouse) await executeQuery(connection, `USE WAREHOUSE "${warehouse}"`);

            // Add LIMIT if not present
            const upperSql = sql.toUpperCase();
            const hasLimit = upperSql.includes('LIMIT');
            const queryWithLimit = hasLimit ? sql : `${sql.replace(/;?\s*$/, '')} LIMIT ${MAX_QUERY_ROWS}`;

            const rows = await executeQuery(connection, queryWithLimit);

            // Clean up connection
            connection.destroy((err) => {
              if (err) logger.warn({ err }, '[Snowflake] Error destroying connection');
            });

            return {
              rows,
              rowCount: rows.length,
              truncated: rows.length === MAX_QUERY_ROWS,
            };
          } catch (error) {
            return toToolError(this.id, error);
          }
        },
      }),

      list_databases: tool({
        description: 'List all databases in Snowflake',
        inputSchema: z.object({}),
        execute: async () => {
          try {
            const connection = await getConnection();
            const rows = await executeQuery(connection, 'SHOW DATABASES');

            connection.destroy((err) => {
              if (err) logger.warn({ err }, '[Snowflake] Error destroying connection');
            });

            interface DatabaseRow {
              name: string;
              created_on: string;
              owner: string;
              comment: string;
            }

            return {
              databases: (rows as DatabaseRow[]).map((row) => ({
                name: row.name,
                createdOn: row.created_on,
                owner: row.owner,
                comment: row.comment,
              })),
            };
          } catch (error) {
            return toToolError(this.id, error);
          }
        },
      }),

      list_schemas: tool({
        description: 'List schemas in a Snowflake database',
        inputSchema: z.object({
          database: z.string().describe('Database name'),
        }),
        execute: async ({ database }: { database: string }) => {
          try {
            const connection = await getConnection();
            const rows = await executeQuery(connection, `SHOW SCHEMAS IN DATABASE "${database}"`);

            connection.destroy((err) => {
              if (err) logger.warn({ err }, '[Snowflake] Error destroying connection');
            });

            interface SchemaRow {
              name: string;
              database_name: string;
              owner: string;
              created_on: string;
            }

            return {
              database,
              schemas: (rows as SchemaRow[]).map((row) => ({
                name: row.name,
                database: row.database_name,
                owner: row.owner,
                createdOn: row.created_on,
              })),
            };
          } catch (error) {
            return toToolError(this.id, error);
          }
        },
      }),

      list_tables: tool({
        description: 'List tables in a Snowflake schema',
        inputSchema: z.object({
          database: z.string().describe('Database name'),
          schema: z.string().describe('Schema name'),
        }),
        execute: async ({ database, schema }: { database: string; schema: string }) => {
          try {
            const connection = await getConnection();
            const rows = await executeQuery(connection, `SHOW TABLES IN "${database}"."${schema}"`);

            connection.destroy((err) => {
              if (err) logger.warn({ err }, '[Snowflake] Error destroying connection');
            });

            interface TableRow {
              name: string;
              database_name: string;
              schema_name: string;
              kind: string;
              rows: number;
              bytes: number;
              owner: string;
              created_on: string;
            }

            return {
              database,
              schema,
              tables: (rows as TableRow[]).map((row) => ({
                name: row.name,
                database: row.database_name,
                schema: row.schema_name,
                kind: row.kind,
                rowCount: row.rows,
                bytes: row.bytes,
                owner: row.owner,
                createdOn: row.created_on,
              })),
            };
          } catch (error) {
            return toToolError(this.id, error);
          }
        },
      }),

      get_table_schema: tool({
        description: 'Get the schema/columns of a Snowflake table',
        inputSchema: z.object({
          table: z.string().describe('Table name'),
          database: z.string().optional().describe('Database name'),
          schema: z.string().optional().describe('Schema name'),
        }),
        execute: async ({ table, database, schema }: { table: string; database?: string; schema?: string }) => {
          try {
            const connection = await getConnection();

            let qualifiedTable = `"${table}"`;
            if (schema) qualifiedTable = `"${schema}".${qualifiedTable}`;
            if (database) qualifiedTable = `"${database}".${qualifiedTable}`;

            const rows = await executeQuery(connection, `DESCRIBE TABLE ${qualifiedTable}`);

            connection.destroy((err) => {
              if (err) logger.warn({ err }, '[Snowflake] Error destroying connection');
            });

            interface ColumnRow {
              name: string;
              type: string;
              kind: string;
              null?: string;
              default: string | null;
              primary_key: string;
              unique_key: string;
              comment: string | null;
            }

            return {
              table,
              database,
              schema,
              columns: (rows as ColumnRow[]).map((row) => ({
                name: row.name,
                type: row.type,
                kind: row.kind,
                nullable: row.null === 'Y',
                default: row.default,
                primaryKey: row.primary_key === 'Y',
                uniqueKey: row.unique_key === 'Y',
                comment: row.comment,
              })),
            };
          } catch (error) {
            return toToolError(this.id, error);
          }
        },
      }),

      preview_table: tool({
        description: 'Preview sample rows from a Snowflake table',
        inputSchema: z.object({
          table: z.string().describe('Table name'),
          database: z.string().optional().describe('Database name'),
          schema: z.string().optional().describe('Schema name'),
          limit: z.number().int().min(1).max(100).optional().describe('Number of rows (default: 10)'),
        }),
        execute: async ({
          table,
          database,
          schema,
          limit,
        }: {
          table: string;
          database?: string;
          schema?: string;
          limit?: number;
        }) => {
          try {
            const connection = await getConnection();

            let qualifiedTable = `"${table}"`;
            if (schema) qualifiedTable = `"${schema}".${qualifiedTable}`;
            if (database) qualifiedTable = `"${database}".${qualifiedTable}`;

            const rowLimit = limit || 10;
            const rows = await executeQuery(connection, `SELECT * FROM ${qualifiedTable} LIMIT ${rowLimit}`);

            connection.destroy((err) => {
              if (err) logger.warn({ err }, '[Snowflake] Error destroying connection');
            });

            return {
              table,
              database,
              schema,
              rows,
              rowCount: rows.length,
            };
          } catch (error) {
            return toToolError(this.id, error);
          }
        },
      }),
    };
  }
}
