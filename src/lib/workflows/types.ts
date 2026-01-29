export type TriggerType = 'email' | 'form_submit' | 'deal_close' | 'webhook' | 'schedule';

export interface Attachment {
  id?: string;
  name?: string;
  filename?: string;
  contentType?: string;
  contentBase64?: string;
  url?: string;
  size?: number;
  metadata?: Record<string, unknown>;
}

export interface WorkflowEvent {
  id: string;
  type: TriggerType;
  payload: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  attachments?: Attachment[];
  receivedAt: string;
}

export interface EmailExtractor {
  field: string;
  source: 'subject' | 'body' | 'text';
  pattern: string;
}

export type ConditionOperator =
  | 'equals'
  | 'contains'
  | 'starts_with'
  | 'ends_with'
  | 'exists'
  | 'not_exists'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte';

export interface Condition {
  path: string;
  operator: ConditionOperator;
  value?: string | number | boolean;
}

export interface ConditionGroup {
  op: 'all' | 'any';
  conditions: Condition[];
}

export interface ScheduleConfig {
  cron: string;
  timezone?: string;
}

export interface TriggerConfig {
  type: TriggerType;
  keywords?: string[];
  senders?: string[];
  conditions?: ConditionGroup;
  extractors?: EmailExtractor[];
  schedule?: ScheduleConfig;
}

export interface ToolRef {
  integrationId: string;
  toolName: string;
  input?: Record<string, unknown>;
}

export interface SlackMessageAction {
  type: 'slack_message';
  channelId: string;
  text: string;
}

export interface IntegrationToolAction {
  type: 'integration_tool';
  integrationId: string;
  toolName: string;
  input?: Record<string, unknown>;
}

export interface DataSyncAction {
  type: 'data_sync';
  source: ToolRef;
  target: ToolRef;
  mapping?: Record<string, string>;
}

export interface FileTransferAction {
  type: 'file_transfer';
  download: ToolRef;
  upload: ToolRef;
  contentField?: string;
  nameField?: string;
}

export interface RouteAttachmentsAction {
  type: 'route_attachments';
  target: ToolRef;
}

export interface StripeUpdateAction {
  type: 'stripe_update';
  toolName: string;
  input?: Record<string, unknown>;
}

export type WorkflowAction =
  | SlackMessageAction
  | IntegrationToolAction
  | DataSyncAction
  | FileTransferAction
  | RouteAttachmentsAction
  | StripeUpdateAction;

export interface Workflow {
  id: string;
  name: string;
  enabled: boolean;
  trigger: TriggerConfig;
  actions: WorkflowAction[];
  createdAt: string;
  updatedAt: string;
}
