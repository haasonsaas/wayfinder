import type { CommandContext, CommandResponse } from '../command-registry.js';
import type {
  Condition,
  ConditionGroup,
  EmailExtractor,
  ScheduleConfig,
  ToolRef,
  TriggerType,
  WorkflowAction,
} from './types.js';
import { workflowService } from './service.js';

type WizardKind = 'workflow' | 'schedule';

type WizardStep =
  | 'workflow_name'
  | 'workflow_trigger'
  | 'workflow_keywords'
  | 'workflow_senders'
  | 'workflow_extractors'
  | 'workflow_conditions'
  | 'schedule_name'
  | 'schedule_frequency'
  | 'schedule_time'
  | 'schedule_day'
  | 'schedule_cron'
  | 'schedule_timezone'
  | 'action_type'
  | 'action_slack_channel'
  | 'action_slack_text'
  | 'action_integration_id'
  | 'action_tool_name'
  | 'action_tool_input'
  | 'action_source_integration'
  | 'action_source_tool'
  | 'action_source_input'
  | 'action_target_integration'
  | 'action_target_tool'
  | 'action_target_input'
  | 'action_mapping'
  | 'action_download_integration'
  | 'action_download_tool'
  | 'action_download_input'
  | 'action_upload_integration'
  | 'action_upload_tool'
  | 'action_upload_input'
  | 'action_stripe_tool'
  | 'action_route_integration'
  | 'action_route_tool'
  | 'action_route_input'
  | 'action_add_another';

interface WorkflowDraft {
  name?: string;
  trigger?: TriggerType;
  keywords?: string[];
  senders?: string[];
  extractors?: EmailExtractor[];
  conditions?: ConditionGroup;
  schedule?: ScheduleConfig;
  actions: WorkflowAction[];
}

interface WizardSession {
  kind: WizardKind;
  step: WizardStep;
  draft: WorkflowDraft;
  actionType?: WorkflowAction['type'];
  actionDraft?: Record<string, unknown>;
  scheduleFrequency?: string;
  scheduleTime?: string;
  scheduleDay?: string;
}

const sessions = new Map<string, WizardSession>();

const getSessionKey = (context: CommandContext): string | null => {
  const channel = context.channelId;
  const user = context.userId;
  if (!channel || !user) {
    return null;
  }
  return [channel, user, context.threadTs].filter(Boolean).join(':');
};

const parseChoice = (input: string, options: string[]): string | null => {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) {
    return null;
  }

  const numeric = Number(trimmed);
  if (!Number.isNaN(numeric) && numeric >= 1 && numeric <= options.length) {
    return options[numeric - 1];
  }

  const match = options.find((option) => option.toLowerCase() === trimmed);
  return match ?? null;
};

const parseYesNo = (input: string): boolean | null => {
  const trimmed = input.trim().toLowerCase();
  if (['yes', 'y'].includes(trimmed)) {
    return true;
  }
  if (['no', 'n'].includes(trimmed)) {
    return false;
  }
  return null;
};

const parseList = (input: string): string[] =>
  input
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);

const parseJson = (input: string): Record<string, unknown> | null => {
  const trimmed = input.trim();
  if (!trimmed || trimmed.toLowerCase() === 'skip') {
    return {};
  }
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
};

const parseMapping = (input: string): Record<string, string> | null => {
  const trimmed = input.trim();
  if (!trimmed || trimmed.toLowerCase() === 'skip') {
    return {};
  }

  const mapping: Record<string, string> = {};
  const lines = trimmed.split(/\n|;/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines) {
    const [key, ...rest] = line.split('=');
    if (!key || rest.length === 0) {
      return null;
    }
    mapping[key.trim()] = rest.join('=').trim();
  }
  return mapping;
};

const parseConditions = (input: string): ConditionGroup | null => {
  const trimmed = input.trim();
  if (!trimmed || trimmed.toLowerCase() === 'skip') {
    return null;
  }

  const lines = trimmed.split(/\n|;/).map((line) => line.trim()).filter(Boolean);
  const conditions: Condition[] = [];

  for (const line of lines) {
    const parts = line.split(' ').filter(Boolean);
    if (parts.length < 2) {
      return null;
    }
    const [path, rawOperator, ...rest] = parts;
    const operator = rawOperator === '=' ? 'equals' : rawOperator.toLowerCase();
    if (
      ![
        'equals',
        'contains',
        'starts_with',
        'ends_with',
        'exists',
        'not_exists',
        'gt',
        'gte',
        'lt',
        'lte',
      ].includes(operator)
    ) {
      return null;
    }

    const value = ['exists', 'not_exists'].includes(operator) ? undefined : rest.join(' ');
    conditions.push({ path, operator: operator as Condition['operator'], value });
  }

  return { op: 'all', conditions };
};

const parseExtractors = (input: string): EmailExtractor[] | null => {
  const trimmed = input.trim();
  if (!trimmed || trimmed.toLowerCase() === 'skip') {
    return null;
  }

  const lines = trimmed.split(/\n|;/).map((line) => line.trim()).filter(Boolean);
  const extractors: EmailExtractor[] = [];
  for (const line of lines) {
    const [field, ...rest] = line.split('=');
    if (!field || rest.length === 0) {
      return null;
    }
    extractors.push({ field: field.trim(), source: 'body', pattern: rest.join('=').trim() });
  }
  return extractors;
};

const buildActionPrompt = () =>
  'Choose an action:\n1) slack_message\n2) integration_tool\n3) data_sync\n4) file_transfer\n5) stripe_update\n6) route_attachments';

const buildTriggerPrompt = () =>
  'Choose a trigger:\n1) email\n2) form_submit\n3) deal_close\n4) webhook';

const buildSchedulePrompt = () =>
  'Choose schedule type:\n1) daily\n2) weekly\n3) monthly\n4) quarterly\n5) custom';

const buildWorkflowSummary = (draft: WorkflowDraft): string => {
  const actionSummary = draft.actions.map((action) => action.type).join(', ') || 'none';
  return `Created workflow "${draft.name}" with trigger "${draft.trigger}" and actions: ${actionSummary}.`;
};

const buildScheduleSummary = (draft: WorkflowDraft): string => {
  const actionSummary = draft.actions.map((action) => action.type).join(', ') || 'none';
  return `Created scheduled task "${draft.name}" with cron "${draft.schedule?.cron}" and actions: ${actionSummary}.`;
};

const toCronFromTime = (time: string): { hour: number; minute: number } | null => {
  const match = time.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    return null;
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return null;
  }
  return { hour, minute };
};

const scheduleCron = (session: WizardSession): string | null => {
  if (!session.scheduleFrequency || !session.scheduleTime) {
    return null;
  }

  const time = toCronFromTime(session.scheduleTime);
  if (!time) {
    return null;
  }

  const { hour, minute } = time;
  if (session.scheduleFrequency === 'daily') {
    return `${minute} ${hour} * * *`;
  }

  if (session.scheduleFrequency === 'weekly') {
    if (!session.scheduleDay) {
      return null;
    }
    return `${minute} ${hour} * * ${session.scheduleDay}`;
  }

  if (session.scheduleFrequency === 'monthly') {
    if (!session.scheduleDay) {
      return null;
    }
    return `${minute} ${hour} ${session.scheduleDay} * *`;
  }

  if (session.scheduleFrequency === 'quarterly') {
    if (!session.scheduleDay) {
      return null;
    }
    return `${minute} ${hour} ${session.scheduleDay} 1,4,7,10 *`;
  }

  return null;
};

const startWorkflowWizard = (key: string): CommandResponse => {
  sessions.set(key, {
    kind: 'workflow',
    step: 'workflow_name',
    draft: { actions: [] },
  });
  return { text: 'Workflow setup: what should we call this workflow?' };
};

const startScheduleWizard = (key: string): CommandResponse => {
  sessions.set(key, {
    kind: 'schedule',
    step: 'schedule_name',
    draft: { actions: [], trigger: 'schedule' },
  });
  return { text: 'Scheduled task setup: what should we call this schedule?' };
};

export const workflowWizard = {
  async handleMessage(text: string, context: CommandContext): Promise<CommandResponse | null> {
    const key = getSessionKey(context);
    if (!key) {
      return null;
    }

    const trimmed = text.trim();
    const normalized = trimmed.toLowerCase();

    const existing = sessions.get(key);

    if (!existing) {
      if (normalized === 'workflow') {
        return startWorkflowWizard(key);
      }
      if (normalized === 'schedule') {
        return startScheduleWizard(key);
      }
      return null;
    }

    if (['cancel', 'exit', 'quit'].includes(normalized)) {
      sessions.delete(key);
      return { text: 'Wizard canceled.' };
    }

    switch (existing.step) {
      case 'workflow_name': {
        if (!trimmed) {
          return { text: 'Please provide a name for this workflow.' };
        }
        existing.draft.name = trimmed;
        existing.step = 'workflow_trigger';
        return { text: buildTriggerPrompt() };
      }
      case 'workflow_trigger': {
        const trigger = parseChoice(trimmed, ['email', 'form_submit', 'deal_close', 'webhook']);
        if (!trigger) {
          return { text: 'Pick a trigger from the list.\n' + buildTriggerPrompt() };
        }
        existing.draft.trigger = trigger as TriggerType;
        existing.step = 'workflow_keywords';
        return { text: 'Enter keyword filters (comma-separated) or type "skip".' };
      }
      case 'workflow_keywords': {
        if (normalized !== 'skip' && trimmed) {
          existing.draft.keywords = parseList(trimmed);
        }
        if (existing.draft.trigger === 'email') {
          existing.step = 'workflow_senders';
          return { text: 'Enter sender filters (emails/domains, comma-separated) or type "skip".' };
        }
        existing.step = 'workflow_conditions';
        return {
          text:
            'Optional condition (e.g., "payload.status equals won" or "payload.amount gt 1000"). Enter multiple with ";" or type "skip".',
        };
      }
      case 'workflow_senders': {
        if (normalized !== 'skip' && trimmed) {
          existing.draft.senders = parseList(trimmed);
        }
        existing.step = 'workflow_extractors';
        return {
          text:
            'Optional email extractors from body (field=regex). Use first capture group. Enter multiple with ";" or type "skip".',
        };
      }
      case 'workflow_extractors': {
        const extractors = parseExtractors(trimmed);
        if (extractors === null && normalized !== 'skip') {
          return { text: 'Could not parse extractors. Use "field=regex" or type "skip".' };
        }
        if (extractors) {
          existing.draft.extractors = extractors;
        }
        existing.step = 'workflow_conditions';
        return {
          text:
            'Optional condition (e.g., "payload.status equals won" or "payload.amount gt 1000"). Enter multiple with ";" or type "skip".',
        };
      }
      case 'workflow_conditions': {
        const conditions = parseConditions(trimmed);
        if (conditions === null && normalized !== 'skip') {
          return { text: 'Could not parse conditions. Try again or type "skip".' };
        }
        if (conditions) {
          existing.draft.conditions = conditions;
        }
        existing.step = 'action_type';
        return { text: buildActionPrompt() };
      }
      case 'schedule_name': {
        if (!trimmed) {
          return { text: 'Please provide a name for this schedule.' };
        }
        existing.draft.name = trimmed;
        existing.step = 'schedule_frequency';
        return { text: buildSchedulePrompt() };
      }
      case 'schedule_frequency': {
        const choice = parseChoice(trimmed, ['daily', 'weekly', 'monthly', 'quarterly', 'custom']);
        if (!choice) {
          return { text: 'Pick a schedule type from the list.\n' + buildSchedulePrompt() };
        }
        existing.scheduleFrequency = choice;
        if (choice === 'custom') {
          existing.step = 'schedule_cron';
          return { text: 'Enter a cron expression (e.g., "0 9 * * 1").' };
        }
        existing.step = 'schedule_time';
        return { text: 'Enter time in HH:MM (24h). Example: 09:30' };
      }
      case 'schedule_time': {
        const parsed = toCronFromTime(trimmed);
        if (!parsed) {
          return { text: 'Invalid time. Use HH:MM (24h), e.g., 09:30.' };
        }
        existing.scheduleTime = trimmed;
        if (existing.scheduleFrequency === 'weekly') {
          existing.step = 'schedule_day';
          return { text: 'Which day of week? Use 0-6 (Sun=0) or mon/tue/wed/thu/fri/sat.' };
        }
        if (existing.scheduleFrequency === 'monthly' || existing.scheduleFrequency === 'quarterly') {
          existing.step = 'schedule_day';
          return { text: 'Which day of month? (1-31)' };
        }
        existing.step = 'schedule_timezone';
        return { text: 'Timezone (e.g., America/New_York) or type "UTC".' };
      }
      case 'schedule_day': {
        const value = trimmed.toLowerCase();
        if (existing.scheduleFrequency === 'weekly') {
          const map: Record<string, string> = {
            sun: '0',
            mon: '1',
            tue: '2',
            wed: '3',
            thu: '4',
            fri: '5',
            sat: '6',
          };
          const day = map[value] ?? (Number.isNaN(Number(value)) ? null : value);
          if (!day || Number(day) < 0 || Number(day) > 6) {
            return { text: 'Invalid day. Use 0-6 or mon/tue/wed/thu/fri/sat.' };
          }
          existing.scheduleDay = day;
          existing.step = 'schedule_timezone';
          return { text: 'Timezone (e.g., America/New_York) or type "UTC".' };
        }

        const dayNumber = Number(value);
        if (Number.isNaN(dayNumber) || dayNumber < 1 || dayNumber > 31) {
          return { text: 'Invalid day of month. Use 1-31.' };
        }
        existing.scheduleDay = String(dayNumber);
        existing.step = 'schedule_timezone';
        return { text: 'Timezone (e.g., America/New_York) or type "UTC".' };
      }
      case 'schedule_cron': {
        if (!trimmed) {
          return { text: 'Please provide a cron expression.' };
        }
        existing.draft.schedule = { cron: trimmed };
        existing.step = 'schedule_timezone';
        return { text: 'Timezone (e.g., America/New_York) or type "UTC".' };
      }
      case 'schedule_timezone': {
        const timezone = trimmed || 'UTC';
        const cron = existing.draft.schedule?.cron ?? scheduleCron(existing);
        if (!cron) {
          return { text: 'Could not build a schedule. Try again or type "cancel".' };
        }
        existing.draft.schedule = { cron, timezone };
        existing.draft.trigger = 'schedule';
        existing.step = 'action_type';
        return { text: buildActionPrompt() };
      }
      case 'action_type': {
        const action = parseChoice(trimmed, [
          'slack_message',
          'integration_tool',
          'data_sync',
          'file_transfer',
          'stripe_update',
          'route_attachments',
        ]);
        if (!action) {
          return { text: 'Pick an action from the list.\n' + buildActionPrompt() };
        }
        existing.actionType = action as WorkflowAction['type'];
        if (action === 'slack_message') {
          existing.step = 'action_slack_channel';
          return { text: 'Where should I post? Reply "here" or provide a channel ID.' };
        }
        if (action === 'integration_tool') {
          existing.step = 'action_integration_id';
          return { text: 'Integration ID to call (e.g., salesforce, github, google_drive).' };
        }
        if (action === 'data_sync') {
          existing.step = 'action_source_integration';
          return { text: 'Source integration ID for sync.' };
        }
        if (action === 'file_transfer') {
          existing.step = 'action_download_integration';
          return { text: 'Download integration ID for file transfer.' };
        }
        if (action === 'stripe_update') {
          existing.step = 'action_stripe_tool';
          return { text: 'Stripe tool name to call (e.g., update_customer).' };
        }
        if (action === 'route_attachments') {
          existing.step = 'action_route_integration';
          return { text: 'Target integration ID for routing attachments.' };
        }
        return { text: 'Unknown action.' };
      }
      case 'action_slack_channel': {
        const channelId = normalized === 'here' ? context.channelId : trimmed;
        if (!channelId) {
          return { text: 'Please provide a valid channel ID or "here".' };
        }
        existing.actionDraft = { channelId };
        existing.step = 'action_slack_text';
        return { text: 'What message should I send? You can use {{payload.*}} placeholders.' };
      }
      case 'action_slack_text': {
        if (!trimmed) {
          return { text: 'Please provide a message to send.' };
        }
        existing.draft.actions.push({
          type: 'slack_message',
          channelId: String(existing.actionDraft?.channelId ?? context.channelId ?? ''),
          text: trimmed,
        });
        existing.actionDraft = undefined;
        existing.actionType = undefined;
        existing.step = 'action_add_another';
        return { text: 'Add another action? (yes/no)' };
      }
      case 'action_integration_id': {
        if (!trimmed) {
          return { text: 'Provide an integration ID.' };
        }
        existing.actionDraft = { integrationId: trimmed };
        existing.step = 'action_tool_name';
        return { text: 'Tool name to call.' };
      }
      case 'action_tool_name': {
        if (!trimmed) {
          return { text: 'Provide a tool name.' };
        }
        existing.actionDraft = { ...existing.actionDraft, toolName: trimmed };
        existing.step = 'action_tool_input';
        return { text: 'Tool input as JSON (or "skip").' };
      }
      case 'action_tool_input': {
        const parsed = parseJson(trimmed);
        if (parsed === null) {
          return { text: 'Invalid JSON. Try again or type "skip".' };
        }
        if (existing.actionType === 'stripe_update') {
          existing.draft.actions.push({
            type: 'stripe_update',
            toolName: String(existing.actionDraft?.toolName ?? ''),
            input: parsed,
          });
        } else {
          existing.draft.actions.push({
            type: 'integration_tool',
            integrationId: String(existing.actionDraft?.integrationId ?? ''),
            toolName: String(existing.actionDraft?.toolName ?? ''),
            input: parsed,
          });
        }
        existing.actionDraft = undefined;
        existing.actionType = undefined;
        existing.step = 'action_add_another';
        return { text: 'Add another action? (yes/no)' };
      }
      case 'action_source_integration': {
        if (!trimmed) {
          return { text: 'Provide a source integration ID.' };
        }
        existing.actionDraft = { source: { integrationId: trimmed } };
        existing.step = 'action_source_tool';
        return { text: 'Source tool name.' };
      }
      case 'action_source_tool': {
        if (!trimmed) {
          return { text: 'Provide a source tool name.' };
        }
        existing.actionDraft = {
          ...existing.actionDraft,
          source: { ...((existing.actionDraft?.source as Record<string, unknown>) ?? {}), toolName: trimmed },
        };
        existing.step = 'action_source_input';
        return { text: 'Source tool input as JSON (or "skip").' };
      }
      case 'action_source_input': {
        const parsed = parseJson(trimmed);
        if (parsed === null) {
          return { text: 'Invalid JSON. Try again or type "skip".' };
        }
        existing.actionDraft = {
          ...existing.actionDraft,
          source: {
            ...((existing.actionDraft?.source as Record<string, unknown>) ?? {}),
            input: parsed,
          },
        };
        existing.step = 'action_target_integration';
        return { text: 'Target integration ID for sync.' };
      }
      case 'action_target_integration': {
        if (!trimmed) {
          return { text: 'Provide a target integration ID.' };
        }
        existing.actionDraft = {
          ...existing.actionDraft,
          target: { integrationId: trimmed },
        };
        existing.step = 'action_target_tool';
        return { text: 'Target tool name.' };
      }
      case 'action_target_tool': {
        if (!trimmed) {
          return { text: 'Provide a target tool name.' };
        }
        existing.actionDraft = {
          ...existing.actionDraft,
          target: { ...((existing.actionDraft?.target as Record<string, unknown>) ?? {}), toolName: trimmed },
        };
        existing.step = 'action_target_input';
        return { text: 'Target tool input as JSON (or "skip").' };
      }
      case 'action_target_input': {
        const parsed = parseJson(trimmed);
        if (parsed === null) {
          return { text: 'Invalid JSON. Try again or type "skip".' };
        }
        existing.actionDraft = {
          ...existing.actionDraft,
          target: {
            ...((existing.actionDraft?.target as Record<string, unknown>) ?? {}),
            input: parsed,
          },
        };
        existing.step = 'action_mapping';
        return { text: 'Optional field mapping (targetField={{source.path}}). Enter lines or type "skip".' };
      }
      case 'action_mapping': {
        const parsed = parseMapping(trimmed);
        if (parsed === null) {
          return { text: 'Invalid mapping. Use "field=value" lines or type "skip".' };
        }
        const source = existing.actionDraft?.source as ToolRef | undefined;
        const target = existing.actionDraft?.target as ToolRef | undefined;
        if (!source || !target) {
          return { text: 'Missing source/target details. Start over with "workflow".' };
        }
        existing.draft.actions.push({
          type: 'data_sync',
          source,
          target,
          mapping: parsed,
        });
        existing.actionDraft = undefined;
        existing.actionType = undefined;
        existing.step = 'action_add_another';
        return { text: 'Add another action? (yes/no)' };
      }
      case 'action_download_integration': {
        if (!trimmed) {
          return { text: 'Provide a download integration ID.' };
        }
        existing.actionDraft = { download: { integrationId: trimmed } };
        existing.step = 'action_download_tool';
        return { text: 'Download tool name.' };
      }
      case 'action_download_tool': {
        if (!trimmed) {
          return { text: 'Provide a download tool name.' };
        }
        existing.actionDraft = {
          ...existing.actionDraft,
          download: { ...((existing.actionDraft?.download as Record<string, unknown>) ?? {}), toolName: trimmed },
        };
        existing.step = 'action_download_input';
        return { text: 'Download tool input as JSON (or "skip").' };
      }
      case 'action_download_input': {
        const parsed = parseJson(trimmed);
        if (parsed === null) {
          return { text: 'Invalid JSON. Try again or type "skip".' };
        }
        existing.actionDraft = {
          ...existing.actionDraft,
          download: {
            ...((existing.actionDraft?.download as Record<string, unknown>) ?? {}),
            input: parsed,
          },
        };
        existing.step = 'action_upload_integration';
        return { text: 'Upload integration ID.' };
      }
      case 'action_upload_integration': {
        if (!trimmed) {
          return { text: 'Provide an upload integration ID.' };
        }
        existing.actionDraft = {
          ...existing.actionDraft,
          upload: { integrationId: trimmed },
        };
        existing.step = 'action_upload_tool';
        return { text: 'Upload tool name.' };
      }
      case 'action_upload_tool': {
        if (!trimmed) {
          return { text: 'Provide an upload tool name.' };
        }
        existing.actionDraft = {
          ...existing.actionDraft,
          upload: { ...((existing.actionDraft?.upload as Record<string, unknown>) ?? {}), toolName: trimmed },
        };
        existing.step = 'action_upload_input';
        return { text: 'Upload tool input as JSON (or "skip").' };
      }
      case 'action_upload_input': {
        const parsed = parseJson(trimmed);
        if (parsed === null) {
          return { text: 'Invalid JSON. Try again or type "skip".' };
        }
        const download = existing.actionDraft?.download as ToolRef | undefined;
        const upload = existing.actionDraft?.upload as ToolRef | undefined;
        if (!download || !upload) {
          return { text: 'Missing download/upload details. Start over with "workflow".' };
        }
        existing.draft.actions.push({
          type: 'file_transfer',
          download,
          upload: {
            ...upload,
            input: parsed,
          },
        });
        existing.actionDraft = undefined;
        existing.actionType = undefined;
        existing.step = 'action_add_another';
        return { text: 'Add another action? (yes/no)' };
      }
      case 'action_stripe_tool': {
        if (!trimmed) {
          return { text: 'Provide a Stripe tool name.' };
        }
        existing.actionDraft = { toolName: trimmed };
        existing.step = 'action_tool_input';
        return { text: 'Stripe input as JSON (or "skip").' };
      }
      case 'action_route_integration': {
        if (!trimmed) {
          return { text: 'Provide a target integration ID.' };
        }
        existing.actionDraft = { integrationId: trimmed };
        existing.step = 'action_route_tool';
        return { text: 'Target tool name.' };
      }
      case 'action_route_tool': {
        if (!trimmed) {
          return { text: 'Provide a target tool name.' };
        }
        existing.actionDraft = { ...existing.actionDraft, toolName: trimmed };
        existing.step = 'action_route_input';
        return { text: 'Routing input as JSON (or "skip").' };
      }
      case 'action_route_input': {
        const parsed = parseJson(trimmed);
        if (parsed === null) {
          return { text: 'Invalid JSON. Try again or type "skip".' };
        }
        existing.draft.actions.push({
          type: 'route_attachments',
          target: {
            integrationId: String(existing.actionDraft?.integrationId ?? ''),
            toolName: String(existing.actionDraft?.toolName ?? ''),
            input: parsed,
          },
        });
        existing.actionDraft = undefined;
        existing.actionType = undefined;
        existing.step = 'action_add_another';
        return { text: 'Add another action? (yes/no)' };
      }
      case 'action_add_another': {
        const yesNo = parseYesNo(trimmed);
        if (yesNo === null) {
          return { text: 'Please answer yes or no.' };
        }
        if (yesNo) {
          existing.step = 'action_type';
          return { text: buildActionPrompt() };
        }

        const trigger = existing.draft.trigger ?? 'webhook';
        const schedule = existing.draft.schedule;

        if (existing.kind === 'schedule' && schedule) {
          await workflowService.createWorkflow({
            name: existing.draft.name ?? 'Scheduled task',
            enabled: true,
            trigger: {
              type: 'schedule',
              schedule,
            },
            actions: existing.draft.actions,
          });
          sessions.delete(key);
          return { text: buildScheduleSummary(existing.draft) };
        }

        await workflowService.createWorkflow({
          name: existing.draft.name ?? 'Workflow',
          enabled: true,
          trigger: {
            type: trigger,
            keywords: existing.draft.keywords,
            senders: existing.draft.senders,
            extractors: existing.draft.extractors,
            conditions: existing.draft.conditions,
          },
          actions: existing.draft.actions,
        });
        sessions.delete(key);
        return { text: buildWorkflowSummary(existing.draft) };
      }
      default:
        sessions.delete(key);
        return { text: 'Wizard state reset. Type "workflow" or "schedule" to start again.' };
    }
  },
};
