import { tool } from 'ai';
import { z } from 'zod';
import { BaseIntegration } from './base.js';
import { toToolError } from '../lib/errors.js';
import { withRetry } from '../lib/retry.js';

interface QuickBooksConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  realmId: string;
  environment: 'sandbox' | 'production';
}

const getQuickBooksConfig = (): QuickBooksConfig | null => {
  const clientId = process.env.QUICKBOOKS_CLIENT_ID;
  const clientSecret = process.env.QUICKBOOKS_CLIENT_SECRET;
  const refreshToken = process.env.QUICKBOOKS_REFRESH_TOKEN;
  const realmId = process.env.QUICKBOOKS_REALM_ID;

  if (!clientId || !clientSecret || !refreshToken || !realmId) {
    return null;
  }

  return {
    clientId,
    clientSecret,
    refreshToken,
    realmId,
    environment: (process.env.QUICKBOOKS_ENVIRONMENT as 'sandbox' | 'production') || 'production',
  };
};

// Token cache for access tokens
let cachedAccessToken: { token: string; expiresAt: number } | null = null;

const getAccessToken = async (): Promise<string> => {
  const config = getQuickBooksConfig();
  if (!config) throw new Error('QuickBooks is not configured');

  // Return cached token if still valid
  if (cachedAccessToken && cachedAccessToken.expiresAt > Date.now()) {
    return cachedAccessToken.token;
  }

  const auth = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');

  const response = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${auth}`,
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: config.refreshToken,
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`QuickBooks OAuth error: ${errorBody}`);
  }

  const data = await response.json() as { access_token: string; expires_in: number };

  cachedAccessToken = {
    token: data.access_token,
    expiresAt: Date.now() + (data.expires_in - 60) * 1000, // Subtract 60s buffer
  };

  return cachedAccessToken.token;
};

const quickbooksFetch = async (path: string, options: RequestInit = {}): Promise<Response> => {
  const config = getQuickBooksConfig();
  if (!config) throw new Error('QuickBooks is not configured');

  const accessToken = await getAccessToken();
  const baseUrl =
    config.environment === 'sandbox'
      ? 'https://sandbox-quickbooks.api.intuit.com'
      : 'https://quickbooks.api.intuit.com';

  const url = `${baseUrl}/v3/company/${config.realmId}${path}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Authorization: `Bearer ${accessToken}`,
      ...(options.headers as Record<string, string> || {}),
    },
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`QuickBooks API error (${response.status}): ${errorBody}`);
  }

  return response;
};

interface QBCustomer {
  Id: string;
  DisplayName: string;
  GivenName: string;
  FamilyName: string;
  PrimaryEmailAddr?: { Address: string };
  PrimaryPhone?: { FreeFormNumber: string };
  Balance: number;
  Active: boolean;
  MetaData: { CreateTime: string; LastUpdatedTime: string };
}

interface QBInvoice {
  Id: string;
  DocNumber: string;
  CustomerRef: { value: string; name: string };
  TxnDate: string;
  DueDate: string;
  TotalAmt: number;
  Balance: number;
  Line: Array<{
    Amount: number;
    Description: string;
    DetailType: string;
  }>;
  MetaData: { CreateTime: string; LastUpdatedTime: string };
}

interface QBPurchase {
  Id: string;
  DocNumber: string;
  TxnDate: string;
  TotalAmt: number;
  EntityRef?: { value: string; name: string };
  AccountRef: { value: string; name: string };
  PaymentType: string;
  Line: Array<{
    Amount: number;
    Description: string;
  }>;
  MetaData: { CreateTime: string; LastUpdatedTime: string };
}

export class QuickBooksIntegration extends BaseIntegration {
  id = 'quickbooks';
  name = 'QuickBooks';
  description = 'Access QuickBooks - accounting sync, invoices, and expenses';
  icon = '📗';

  isEnabled(): boolean {
    return getQuickBooksConfig() !== null;
  }

  getTools() {
    return {
      query: tool({
        description: 'Query QuickBooks data using QuickBooks Query Language',
        inputSchema: z.object({
          query: z.string().describe('QuickBooks Query (e.g., "SELECT * FROM Customer")'),
          maxResults: z.number().int().min(1).max(1000).optional().describe('Max results'),
        }),
        execute: async ({ query, maxResults }: { query: string; maxResults?: number }) => {
          try {
            const limit = maxResults || 100;
            const fullQuery = query.includes('MAXRESULTS') ? query : `${query} MAXRESULTS ${limit}`;

            const response = await withRetry(
              () => quickbooksFetch(`/query?query=${encodeURIComponent(fullQuery)}`),
              { integrationId: this.id, operation: 'query' },
            );

            const data = await response.json() as { QueryResponse: Record<string, unknown[]> };

            // Extract the entity type from the response
            const entityKey = Object.keys(data.QueryResponse).find((k) => k !== 'startPosition' && k !== 'maxResults');
            const results = entityKey ? data.QueryResponse[entityKey] : [];

            return {
              results,
              count: results.length,
            };
          } catch (error) {
            return toToolError(this.id, error);
          }
        },
      }),

      list_customers: tool({
        description: 'List customers in QuickBooks',
        inputSchema: z.object({
          query: z.string().optional().describe('Search by name or email'),
          active: z.boolean().optional().describe('Filter by active status'),
          limit: z.number().int().min(1).max(100).optional().describe('Max results (default: 25)'),
        }),
        execute: async ({ query, active, limit }: { query?: string; active?: boolean; limit?: number }) => {
          try {
            let qbQuery = 'SELECT * FROM Customer';
            const conditions: string[] = [];

            if (active !== undefined) {
              conditions.push(`Active = ${active}`);
            }
            if (query) {
              conditions.push(`DisplayName LIKE '%${query}%'`);
            }

            if (conditions.length > 0) {
              qbQuery += ` WHERE ${conditions.join(' AND ')}`;
            }

            qbQuery += ` MAXRESULTS ${limit || 25}`;

            const response = await withRetry(
              () => quickbooksFetch(`/query?query=${encodeURIComponent(qbQuery)}`),
              { integrationId: this.id, operation: 'list customers' },
            );

            const data = await response.json() as { QueryResponse: { Customer?: QBCustomer[] } };
            const customers = data.QueryResponse.Customer || [];

            return {
              customers: customers.map((c) => ({
                id: c.Id,
                displayName: c.DisplayName,
                givenName: c.GivenName,
                familyName: c.FamilyName,
                email: c.PrimaryEmailAddr?.Address,
                phone: c.PrimaryPhone?.FreeFormNumber,
                balance: c.Balance,
                active: c.Active,
                createdAt: c.MetaData.CreateTime,
                updatedAt: c.MetaData.LastUpdatedTime,
              })),
              count: customers.length,
            };
          } catch (error) {
            return toToolError(this.id, error);
          }
        },
      }),

      get_customer: tool({
        description: 'Get details of a specific customer',
        inputSchema: z.object({
          customerId: z.string().describe('QuickBooks customer ID'),
        }),
        execute: async ({ customerId }: { customerId: string }) => {
          try {
            const response = await withRetry(
              () => quickbooksFetch(`/customer/${customerId}`),
              { integrationId: this.id, operation: 'get customer' },
            );

            const data = await response.json() as { Customer: QBCustomer };
            const c = data.Customer;

            return {
              id: c.Id,
              displayName: c.DisplayName,
              givenName: c.GivenName,
              familyName: c.FamilyName,
              email: c.PrimaryEmailAddr?.Address,
              phone: c.PrimaryPhone?.FreeFormNumber,
              balance: c.Balance,
              active: c.Active,
              createdAt: c.MetaData.CreateTime,
              updatedAt: c.MetaData.LastUpdatedTime,
            };
          } catch (error) {
            return toToolError(this.id, error);
          }
        },
      }),

      list_invoices: tool({
        description: 'List invoices in QuickBooks',
        inputSchema: z.object({
          customerId: z.string().optional().describe('Filter by customer'),
          startDate: z.string().optional().describe('Start date (YYYY-MM-DD)'),
          endDate: z.string().optional().describe('End date (YYYY-MM-DD)'),
          limit: z.number().int().min(1).max(100).optional().describe('Max results (default: 25)'),
        }),
        execute: async ({
          customerId,
          startDate,
          endDate,
          limit,
        }: {
          customerId?: string;
          startDate?: string;
          endDate?: string;
          limit?: number;
        }) => {
          try {
            let qbQuery = 'SELECT * FROM Invoice';
            const conditions: string[] = [];

            if (customerId) {
              conditions.push(`CustomerRef = '${customerId}'`);
            }
            if (startDate) {
              conditions.push(`TxnDate >= '${startDate}'`);
            }
            if (endDate) {
              conditions.push(`TxnDate <= '${endDate}'`);
            }

            if (conditions.length > 0) {
              qbQuery += ` WHERE ${conditions.join(' AND ')}`;
            }

            qbQuery += ` MAXRESULTS ${limit || 25}`;

            const response = await withRetry(
              () => quickbooksFetch(`/query?query=${encodeURIComponent(qbQuery)}`),
              { integrationId: this.id, operation: 'list invoices' },
            );

            const data = await response.json() as { QueryResponse: { Invoice?: QBInvoice[] } };
            const invoices = data.QueryResponse.Invoice || [];

            return {
              invoices: invoices.map((inv) => ({
                id: inv.Id,
                docNumber: inv.DocNumber,
                customer: { id: inv.CustomerRef.value, name: inv.CustomerRef.name },
                txnDate: inv.TxnDate,
                dueDate: inv.DueDate,
                totalAmount: inv.TotalAmt,
                balance: inv.Balance,
                lineItemCount: inv.Line.length,
                createdAt: inv.MetaData.CreateTime,
                updatedAt: inv.MetaData.LastUpdatedTime,
              })),
              count: invoices.length,
            };
          } catch (error) {
            return toToolError(this.id, error);
          }
        },
      }),

      get_invoice: tool({
        description: 'Get details of a specific invoice',
        inputSchema: z.object({
          invoiceId: z.string().describe('QuickBooks invoice ID'),
        }),
        execute: async ({ invoiceId }: { invoiceId: string }) => {
          try {
            const response = await withRetry(
              () => quickbooksFetch(`/invoice/${invoiceId}`),
              { integrationId: this.id, operation: 'get invoice' },
            );

            const data = await response.json() as { Invoice: QBInvoice };
            const inv = data.Invoice;

            return {
              id: inv.Id,
              docNumber: inv.DocNumber,
              customer: { id: inv.CustomerRef.value, name: inv.CustomerRef.name },
              txnDate: inv.TxnDate,
              dueDate: inv.DueDate,
              totalAmount: inv.TotalAmt,
              balance: inv.Balance,
              lineItems: inv.Line.map((line) => ({
                amount: line.Amount,
                description: line.Description,
                detailType: line.DetailType,
              })),
              createdAt: inv.MetaData.CreateTime,
              updatedAt: inv.MetaData.LastUpdatedTime,
            };
          } catch (error) {
            return toToolError(this.id, error);
          }
        },
      }),

      list_expenses: tool({
        description: 'List expenses/purchases in QuickBooks',
        inputSchema: z.object({
          vendorId: z.string().optional().describe('Filter by vendor'),
          startDate: z.string().optional().describe('Start date (YYYY-MM-DD)'),
          endDate: z.string().optional().describe('End date (YYYY-MM-DD)'),
          limit: z.number().int().min(1).max(100).optional().describe('Max results (default: 25)'),
        }),
        execute: async ({
          vendorId,
          startDate,
          endDate,
          limit,
        }: {
          vendorId?: string;
          startDate?: string;
          endDate?: string;
          limit?: number;
        }) => {
          try {
            let qbQuery = 'SELECT * FROM Purchase';
            const conditions: string[] = [];

            if (vendorId) {
              conditions.push(`EntityRef = '${vendorId}'`);
            }
            if (startDate) {
              conditions.push(`TxnDate >= '${startDate}'`);
            }
            if (endDate) {
              conditions.push(`TxnDate <= '${endDate}'`);
            }

            if (conditions.length > 0) {
              qbQuery += ` WHERE ${conditions.join(' AND ')}`;
            }

            qbQuery += ` MAXRESULTS ${limit || 25}`;

            const response = await withRetry(
              () => quickbooksFetch(`/query?query=${encodeURIComponent(qbQuery)}`),
              { integrationId: this.id, operation: 'list expenses' },
            );

            const data = await response.json() as { QueryResponse: { Purchase?: QBPurchase[] } };
            const purchases = data.QueryResponse.Purchase || [];

            return {
              expenses: purchases.map((p) => ({
                id: p.Id,
                docNumber: p.DocNumber,
                txnDate: p.TxnDate,
                totalAmount: p.TotalAmt,
                vendor: p.EntityRef ? { id: p.EntityRef.value, name: p.EntityRef.name } : null,
                account: { id: p.AccountRef.value, name: p.AccountRef.name },
                paymentType: p.PaymentType,
                lineItemCount: p.Line.length,
                createdAt: p.MetaData.CreateTime,
                updatedAt: p.MetaData.LastUpdatedTime,
              })),
              count: purchases.length,
            };
          } catch (error) {
            return toToolError(this.id, error);
          }
        },
      }),

      get_profit_loss: tool({
        description: 'Get Profit & Loss report',
        inputSchema: z.object({
          startDate: z.string().describe('Start date (YYYY-MM-DD)'),
          endDate: z.string().describe('End date (YYYY-MM-DD)'),
        }),
        execute: async ({ startDate, endDate }: { startDate: string; endDate: string }) => {
          try {
            const response = await withRetry(
              () => quickbooksFetch(`/reports/ProfitAndLoss?start_date=${startDate}&end_date=${endDate}`),
              { integrationId: this.id, operation: 'get profit & loss' },
            );

            const data = await response.json() as {
              Header: { StartPeriod: string; EndPeriod: string; Currency: string };
              Rows: { Row: Array<{ Summary?: { ColData: Array<{ value: string }> }; Header?: { ColData: Array<{ value: string }> }; type: string }> };
            };

            // Extract summary rows
            const summaryRows = data.Rows.Row.filter((r) => r.type === 'Section' && r.Summary);

            const extractValue = (row: { Summary?: { ColData: Array<{ value: string }> } }) => {
              if (!row.Summary) return 0;
              const val = row.Summary.ColData[1]?.value;
              return val ? parseFloat(val) : 0;
            };

            return {
              period: { startDate: data.Header.StartPeriod, endDate: data.Header.EndPeriod },
              currency: data.Header.Currency,
              summary: summaryRows.map((row) => ({
                label: row.Header?.ColData[0]?.value || 'Unknown',
                value: extractValue(row),
              })),
            };
          } catch (error) {
            return toToolError(this.id, error);
          }
        },
      }),

      get_balance_sheet: tool({
        description: 'Get Balance Sheet report',
        inputSchema: z.object({
          asOfDate: z.string().optional().describe('As of date (YYYY-MM-DD, default: today)'),
        }),
        execute: async ({ asOfDate }: { asOfDate?: string }) => {
          try {
            const date = asOfDate || new Date().toISOString().split('T')[0];

            const response = await withRetry(
              () => quickbooksFetch(`/reports/BalanceSheet?date_macro=custom&start_date=${date}&end_date=${date}`),
              { integrationId: this.id, operation: 'get balance sheet' },
            );

            const data = await response.json() as {
              Header: { StartPeriod: string; EndPeriod: string; Currency: string };
              Rows: { Row: Array<{ Summary?: { ColData: Array<{ value: string }> }; Header?: { ColData: Array<{ value: string }> }; type: string }> };
            };

            // Extract summary rows
            const summaryRows = data.Rows.Row.filter((r) => r.type === 'Section' && r.Summary);

            const extractValue = (row: { Summary?: { ColData: Array<{ value: string }> } }) => {
              if (!row.Summary) return 0;
              const val = row.Summary.ColData[1]?.value;
              return val ? parseFloat(val) : 0;
            };

            return {
              asOfDate: data.Header.EndPeriod,
              currency: data.Header.Currency,
              summary: summaryRows.map((row) => ({
                label: row.Header?.ColData[0]?.value || 'Unknown',
                value: extractValue(row),
              })),
            };
          } catch (error) {
            return toToolError(this.id, error);
          }
        },
      }),

      list_vendors: tool({
        description: 'List vendors in QuickBooks',
        inputSchema: z.object({
          active: z.boolean().optional().describe('Filter by active status'),
          limit: z.number().int().min(1).max(100).optional().describe('Max results (default: 25)'),
        }),
        execute: async ({ active, limit }: { active?: boolean; limit?: number }) => {
          try {
            let qbQuery = 'SELECT * FROM Vendor';

            if (active !== undefined) {
              qbQuery += ` WHERE Active = ${active}`;
            }

            qbQuery += ` MAXRESULTS ${limit || 25}`;

            const response = await withRetry(
              () => quickbooksFetch(`/query?query=${encodeURIComponent(qbQuery)}`),
              { integrationId: this.id, operation: 'list vendors' },
            );

            interface QBVendor {
              Id: string;
              DisplayName: string;
              PrimaryEmailAddr?: { Address: string };
              PrimaryPhone?: { FreeFormNumber: string };
              Balance: number;
              Active: boolean;
              MetaData: { CreateTime: string; LastUpdatedTime: string };
            }

            const data = await response.json() as { QueryResponse: { Vendor?: QBVendor[] } };
            const vendors = data.QueryResponse.Vendor || [];

            return {
              vendors: vendors.map((v) => ({
                id: v.Id,
                displayName: v.DisplayName,
                email: v.PrimaryEmailAddr?.Address,
                phone: v.PrimaryPhone?.FreeFormNumber,
                balance: v.Balance,
                active: v.Active,
                createdAt: v.MetaData.CreateTime,
                updatedAt: v.MetaData.LastUpdatedTime,
              })),
              count: vendors.length,
            };
          } catch (error) {
            return toToolError(this.id, error);
          }
        },
      }),
    };
  }
}
