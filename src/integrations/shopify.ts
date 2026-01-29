import { tool } from 'ai';
import { z } from 'zod';
import { BaseIntegration } from './base.js';
import { toToolError } from '../lib/errors.js';
import { withRetry } from '../lib/retry.js';

interface ShopifyConfig {
  shopName: string;
  accessToken: string;
  apiVersion: string;
}

const getShopifyConfig = (): ShopifyConfig | null => {
  const shopName = process.env.SHOPIFY_SHOP_NAME;
  const accessToken = process.env.SHOPIFY_ACCESS_TOKEN;

  if (!shopName || !accessToken) return null;

  return {
    shopName,
    accessToken,
    apiVersion: process.env.SHOPIFY_API_VERSION || '2024-01',
  };
};

const shopifyFetch = async (path: string, options: RequestInit = {}): Promise<Response> => {
  const config = getShopifyConfig();
  if (!config) throw new Error('Shopify is not configured');

  const url = `https://${config.shopName}.myshopify.com/admin/api/${config.apiVersion}${path}`;

  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': config.accessToken,
      ...(options.headers as Record<string, string> || {}),
    },
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Shopify API error (${response.status}): ${errorBody}`);
  }

  return response;
};

interface ShopifyOrder {
  id: number;
  name: string;
  email: string;
  financial_status: string;
  fulfillment_status: string | null;
  total_price: string;
  subtotal_price: string;
  total_tax: string;
  currency: string;
  created_at: string;
  updated_at: string;
  customer: { id: number; first_name: string; last_name: string; email: string } | null;
  line_items: Array<{
    id: number;
    title: string;
    quantity: number;
    price: string;
    sku: string;
    variant_title: string;
  }>;
  shipping_address: {
    address1: string;
    city: string;
    province: string;
    country: string;
    zip: string;
  } | null;
}

interface ShopifyProduct {
  id: number;
  title: string;
  body_html: string;
  vendor: string;
  product_type: string;
  status: string;
  tags: string;
  created_at: string;
  updated_at: string;
  variants: Array<{
    id: number;
    title: string;
    price: string;
    sku: string;
    inventory_quantity: number;
    inventory_item_id: number;
  }>;
  images: Array<{ id: number; src: string; alt: string }>;
}

interface ShopifyCustomer {
  id: number;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  orders_count: number;
  total_spent: string;
  created_at: string;
  updated_at: string;
  default_address: {
    address1: string;
    city: string;
    province: string;
    country: string;
    zip: string;
  } | null;
}

export class ShopifyIntegration extends BaseIntegration {
  id = 'shopify';
  name = 'Shopify';
  description = 'Access Shopify - orders, inventory, and products';
  icon = '🛍️';

  isEnabled(): boolean {
    return getShopifyConfig() !== null;
  }

  getTools() {
    return {
      list_orders: tool({
        description: 'List orders from Shopify',
        inputSchema: z.object({
          status: z.enum(['open', 'closed', 'cancelled', 'any']).optional().describe('Filter by order status'),
          financialStatus: z.enum(['pending', 'authorized', 'paid', 'partially_paid', 'refunded', 'partially_refunded', 'voided', 'any']).optional().describe('Filter by financial status'),
          createdAtMin: z.string().optional().describe('Orders created after (ISO date)'),
          createdAtMax: z.string().optional().describe('Orders created before (ISO date)'),
          limit: z.number().int().min(1).max(250).optional().describe('Max results (default: 50)'),
        }),
        execute: async ({
          status,
          financialStatus,
          createdAtMin,
          createdAtMax,
          limit,
        }: {
          status?: string;
          financialStatus?: string;
          createdAtMin?: string;
          createdAtMax?: string;
          limit?: number;
        }) => {
          try {
            const params = new URLSearchParams();
            params.set('limit', String(limit || 50));
            if (status && status !== 'any') params.set('status', status);
            if (financialStatus && financialStatus !== 'any') params.set('financial_status', financialStatus);
            if (createdAtMin) params.set('created_at_min', createdAtMin);
            if (createdAtMax) params.set('created_at_max', createdAtMax);

            const response = await withRetry(
              () => shopifyFetch(`/orders.json?${params.toString()}`),
              { integrationId: this.id, operation: 'list orders' },
            );

            const data = await response.json() as { orders: ShopifyOrder[] };

            return {
              orders: data.orders.map((order) => ({
                id: order.id,
                name: order.name,
                email: order.email,
                financialStatus: order.financial_status,
                fulfillmentStatus: order.fulfillment_status,
                totalPrice: order.total_price,
                subtotalPrice: order.subtotal_price,
                totalTax: order.total_tax,
                currency: order.currency,
                customer: order.customer
                  ? { id: order.customer.id, name: `${order.customer.first_name} ${order.customer.last_name}`, email: order.customer.email }
                  : null,
                itemCount: order.line_items.length,
                createdAt: order.created_at,
                updatedAt: order.updated_at,
              })),
              count: data.orders.length,
            };
          } catch (error) {
            return toToolError(this.id, error);
          }
        },
      }),

      get_order: tool({
        description: 'Get details of a specific order',
        inputSchema: z.object({
          orderId: z.string().describe('Shopify order ID'),
        }),
        execute: async ({ orderId }: { orderId: string }) => {
          try {
            const response = await withRetry(
              () => shopifyFetch(`/orders/${orderId}.json`),
              { integrationId: this.id, operation: 'get order' },
            );

            const data = await response.json() as { order: ShopifyOrder };
            const order = data.order;

            return {
              id: order.id,
              name: order.name,
              email: order.email,
              financialStatus: order.financial_status,
              fulfillmentStatus: order.fulfillment_status,
              totalPrice: order.total_price,
              subtotalPrice: order.subtotal_price,
              totalTax: order.total_tax,
              currency: order.currency,
              customer: order.customer
                ? { id: order.customer.id, name: `${order.customer.first_name} ${order.customer.last_name}`, email: order.customer.email }
                : null,
              lineItems: order.line_items.map((item) => ({
                id: item.id,
                title: item.title,
                quantity: item.quantity,
                price: item.price,
                sku: item.sku,
                variantTitle: item.variant_title,
              })),
              shippingAddress: order.shipping_address
                ? {
                    address: order.shipping_address.address1,
                    city: order.shipping_address.city,
                    province: order.shipping_address.province,
                    country: order.shipping_address.country,
                    zip: order.shipping_address.zip,
                  }
                : null,
              createdAt: order.created_at,
              updatedAt: order.updated_at,
            };
          } catch (error) {
            return toToolError(this.id, error);
          }
        },
      }),

      list_products: tool({
        description: 'List products from Shopify',
        inputSchema: z.object({
          status: z.enum(['active', 'archived', 'draft']).optional().describe('Filter by product status'),
          productType: z.string().optional().describe('Filter by product type'),
          vendor: z.string().optional().describe('Filter by vendor'),
          limit: z.number().int().min(1).max(250).optional().describe('Max results (default: 50)'),
        }),
        execute: async ({
          status,
          productType,
          vendor,
          limit,
        }: {
          status?: string;
          productType?: string;
          vendor?: string;
          limit?: number;
        }) => {
          try {
            const params = new URLSearchParams();
            params.set('limit', String(limit || 50));
            if (status) params.set('status', status);
            if (productType) params.set('product_type', productType);
            if (vendor) params.set('vendor', vendor);

            const response = await withRetry(
              () => shopifyFetch(`/products.json?${params.toString()}`),
              { integrationId: this.id, operation: 'list products' },
            );

            const data = await response.json() as { products: ShopifyProduct[] };

            return {
              products: data.products.map((product) => ({
                id: product.id,
                title: product.title,
                vendor: product.vendor,
                productType: product.product_type,
                status: product.status,
                tags: product.tags.split(', ').filter(Boolean),
                variantsCount: product.variants.length,
                totalInventory: product.variants.reduce((sum, v) => sum + v.inventory_quantity, 0),
                priceRange: {
                  min: Math.min(...product.variants.map((v) => parseFloat(v.price))),
                  max: Math.max(...product.variants.map((v) => parseFloat(v.price))),
                },
                createdAt: product.created_at,
                updatedAt: product.updated_at,
              })),
              count: data.products.length,
            };
          } catch (error) {
            return toToolError(this.id, error);
          }
        },
      }),

      get_product: tool({
        description: 'Get details of a specific product',
        inputSchema: z.object({
          productId: z.string().describe('Shopify product ID'),
        }),
        execute: async ({ productId }: { productId: string }) => {
          try {
            const response = await withRetry(
              () => shopifyFetch(`/products/${productId}.json`),
              { integrationId: this.id, operation: 'get product' },
            );

            const data = await response.json() as { product: ShopifyProduct };
            const product = data.product;

            return {
              id: product.id,
              title: product.title,
              description: product.body_html?.replace(/<[^>]*>/g, '').substring(0, 500),
              vendor: product.vendor,
              productType: product.product_type,
              status: product.status,
              tags: product.tags.split(', ').filter(Boolean),
              variants: product.variants.map((v) => ({
                id: v.id,
                title: v.title,
                price: v.price,
                sku: v.sku,
                inventoryQuantity: v.inventory_quantity,
                inventoryItemId: v.inventory_item_id,
              })),
              images: product.images.map((img) => ({
                id: img.id,
                src: img.src,
                alt: img.alt,
              })),
              createdAt: product.created_at,
              updatedAt: product.updated_at,
            };
          } catch (error) {
            return toToolError(this.id, error);
          }
        },
      }),

      list_inventory: tool({
        description: 'List inventory levels across locations',
        inputSchema: z.object({
          locationId: z.string().optional().describe('Filter by location'),
          limit: z.number().int().min(1).max(250).optional().describe('Max results (default: 50)'),
        }),
        execute: async ({ locationId, limit }: { locationId?: string; limit?: number }) => {
          try {
            const params = new URLSearchParams();
            params.set('limit', String(limit || 50));
            if (locationId) params.set('location_ids', locationId);

            const response = await withRetry(
              () => shopifyFetch(`/inventory_levels.json?${params.toString()}`),
              { integrationId: this.id, operation: 'list inventory' },
            );

            const data = await response.json() as {
              inventory_levels: Array<{
                inventory_item_id: number;
                location_id: number;
                available: number;
                updated_at: string;
              }>;
            };

            return {
              inventoryLevels: data.inventory_levels.map((level) => ({
                inventoryItemId: level.inventory_item_id,
                locationId: level.location_id,
                available: level.available,
                updatedAt: level.updated_at,
              })),
              count: data.inventory_levels.length,
            };
          } catch (error) {
            return toToolError(this.id, error);
          }
        },
      }),

      list_customers: tool({
        description: 'List customers from Shopify',
        inputSchema: z.object({
          query: z.string().optional().describe('Search by name or email'),
          limit: z.number().int().min(1).max(250).optional().describe('Max results (default: 50)'),
        }),
        execute: async ({ query, limit }: { query?: string; limit?: number }) => {
          try {
            const params = new URLSearchParams();
            params.set('limit', String(limit || 50));

            const response = await withRetry(
              () => shopifyFetch(`/customers.json?${params.toString()}`),
              { integrationId: this.id, operation: 'list customers' },
            );

            const data = await response.json() as { customers: ShopifyCustomer[] };
            let customers = data.customers;

            // Client-side filter if query provided
            if (query) {
              const lowerQuery = query.toLowerCase();
              customers = customers.filter(
                (c) =>
                  c.first_name?.toLowerCase().includes(lowerQuery) ||
                  c.last_name?.toLowerCase().includes(lowerQuery) ||
                  c.email?.toLowerCase().includes(lowerQuery),
              );
            }

            return {
              customers: customers.map((customer) => ({
                id: customer.id,
                name: `${customer.first_name} ${customer.last_name}`,
                email: customer.email,
                phone: customer.phone,
                ordersCount: customer.orders_count,
                totalSpent: customer.total_spent,
                createdAt: customer.created_at,
                updatedAt: customer.updated_at,
              })),
              count: customers.length,
            };
          } catch (error) {
            return toToolError(this.id, error);
          }
        },
      }),

      get_sales_summary: tool({
        description: 'Get sales summary for a time period',
        inputSchema: z.object({
          startDate: z.string().describe('Start date (YYYY-MM-DD)'),
          endDate: z.string().describe('End date (YYYY-MM-DD)'),
        }),
        execute: async ({ startDate, endDate }: { startDate: string; endDate: string }) => {
          try {
            const params = new URLSearchParams();
            params.set('status', 'any');
            params.set('financial_status', 'paid');
            params.set('created_at_min', `${startDate}T00:00:00Z`);
            params.set('created_at_max', `${endDate}T23:59:59Z`);
            params.set('limit', '250');

            const response = await withRetry(
              () => shopifyFetch(`/orders.json?${params.toString()}`),
              { integrationId: this.id, operation: 'get sales summary' },
            );

            const data = await response.json() as { orders: ShopifyOrder[] };

            // Calculate summary
            let totalSales = 0;
            let totalTax = 0;
            let orderCount = 0;
            const byCurrency: Record<string, { sales: number; count: number }> = {};

            for (const order of data.orders) {
              const price = parseFloat(order.total_price);
              const tax = parseFloat(order.total_tax);
              totalSales += price;
              totalTax += tax;
              orderCount++;

              if (!byCurrency[order.currency]) {
                byCurrency[order.currency] = { sales: 0, count: 0 };
              }
              byCurrency[order.currency].sales += price;
              byCurrency[order.currency].count++;
            }

            return {
              period: { startDate, endDate },
              totalOrders: orderCount,
              totalSales,
              totalTax,
              averageOrderValue: orderCount > 0 ? totalSales / orderCount : 0,
              byCurrency: Object.entries(byCurrency).map(([currency, data]) => ({
                currency,
                totalSales: data.sales,
                orderCount: data.count,
              })),
            };
          } catch (error) {
            return toToolError(this.id, error);
          }
        },
      }),

      list_locations: tool({
        description: 'List all locations/warehouses',
        inputSchema: z.object({}),
        execute: async () => {
          try {
            const response = await withRetry(
              () => shopifyFetch('/locations.json'),
              { integrationId: this.id, operation: 'list locations' },
            );

            const data = await response.json() as {
              locations: Array<{
                id: number;
                name: string;
                address1: string;
                city: string;
                province: string;
                country: string;
                zip: string;
                active: boolean;
              }>;
            };

            return {
              locations: data.locations.map((loc) => ({
                id: loc.id,
                name: loc.name,
                address: loc.address1,
                city: loc.city,
                province: loc.province,
                country: loc.country,
                zip: loc.zip,
                active: loc.active,
              })),
            };
          } catch (error) {
            return toToolError(this.id, error);
          }
        },
      }),
    };
  }
}
