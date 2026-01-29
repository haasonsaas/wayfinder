# Adept

An open-source AI Computer for Business - a Slack-first AI agent that connects your business tools.

Inspired by [Adapt](https://adapt.com), built with [Vercel AI SDK 6](https://ai-sdk.dev/) and TypeScript.

## Features

- **Slack-native**: Tag `@Adept` in any channel or DM to get answers
- **Multi-system context**: Pulls data from CRM, analytics, GitHub, and more
- **Tool-based architecture**: Extensible integration system using AI SDK 6's `ToolLoopAgent`
- **Smart routing**: Uses the best AI model for each task (Claude, GPT-4o)

## Quick Start

### 1. Create a Slack App

1. Go to [https://api.slack.com/apps](https://api.slack.com/apps) and click "Create New App"
2. Choose "From scratch" and name it (e.g., "Adept")
3. Select your workspace

### 2. Configure Slack App Settings

**Basic Information:**
- Note your "Signing Secret" → `SLACK_SIGNING_SECRET`

**App Home:**
- Enable "Messages Tab"
- Check "Allow users to send Slash commands and messages from the messages tab"

**OAuth & Permissions - Bot Token Scopes:**
- `app_mentions:read`
- `assistant:write`
- `chat:write`
- `im:history`
- `im:read`
- `im:write`

Install the app to your workspace and note the "Bot User OAuth Token" → `SLACK_BOT_TOKEN`

**Socket Mode:**
- Enable Socket Mode
- Generate an App-Level Token with `connections:write` scope → `SLACK_APP_TOKEN`

**Event Subscriptions:**
- Enable Events
- Subscribe to bot events:
  - `app_mention`
  - `assistant_thread_started`
  - `message.im`

### 3. Set Up Environment

```bash
cp .env.example .env
```

Edit `.env` with your credentials:

```env
SLACK_BOT_TOKEN=xoxb-your-bot-token
SLACK_SIGNING_SECRET=your-signing-secret
SLACK_APP_TOKEN=xapp-your-app-token

# At least one AI provider required
ANTHROPIC_API_KEY=sk-ant-your-key
# or
OPENAI_API_KEY=sk-your-key

DEFAULT_AI_PROVIDER=anthropic
```

### 4. Install and Run

```bash
npm install
npm run dev
```

## Usage

### In Channels
Mention `@Adept` with your question:
```
@Adept What should I know about Jillian Johnson from Acme Corp before our call?
```

### In Direct Messages
Just send a message directly to Adept:
```
What's our current sales pipeline looking like?
```

## Example Queries

**Sales:**
- "What should I know about [person] before our call?"
- "Show me the current sales pipeline"
- "Find all deals in negotiation stage"

**Analytics:**
- "What are our key metrics this month?"
- "Why has our CAC increased?"
- "Show me revenue breakdown by channel"

**Product:**
- "Are there any duplicate GitHub issues?"
- "What PRs need review?"
- "Show me open bugs"

**Code Execution (Daytona):**
- "Calculate the compound interest on $10,000 at 5% for 10 years"
- "Write a Python script to parse this CSV data"
- "Run this code and tell me the output"

## Architecture

```
src/
├── index.ts               # Slack app entry point
├── handlers/              # Slack event handlers
│   ├── app-mention.ts     # @mention handling
│   ├── assistant-flow.ts  # Unified assistant logic
│   └── direct-message.ts  # DM handling
├── integrations/          # Business tool integrations
│   ├── index.ts           # Integration registration
│   ├── registry.ts        # Integration registry
│   ├── base.ts            # Base integration class
│   ├── salesforce.ts      # Salesforce CRM integration
│   ├── google-drive.ts    # Google Drive integration
│   ├── github.ts          # GitHub integration
│   └── daytona.ts         # Daytona code execution sandbox
├── lib/
│   ├── agent.ts           # AI Agent setup
│   ├── command-builders.ts # Slack block builders
│   ├── config.ts          # Configuration loading
│   ├── integration-config.ts # Integration health & config
│   ├── oauth.ts           # OAuth utilities
│   ├── oauth-server.ts    # OAuth callback server
│   ├── retry.ts           # Retry logic
│   ├── slack.ts           # Slack API utilities
│   ├── token-store.ts     # Token management
│   └── logger.ts          # Pino logger setup
└── types/
    └── index.ts           # Shared types
```

## Adding Custom Integrations

Create a new integration by extending `BaseIntegration`:

```typescript
import { tool } from 'ai';
import { z } from 'zod';
import { BaseIntegration } from './base.js';

export class MyIntegration extends BaseIntegration {
  id = 'my-integration';
  name = 'My Integration';
  description = 'Description of what this integration does';

  isEnabled(): boolean {
    return !!process.env.MY_INTEGRATION_API_KEY;
  }

  getTools() {
    return {
      my_tool: tool({
        description: 'What this tool does',
        parameters: z.object({
          query: z.string().describe('Search query'),
        }),
        execute: async ({ query }) => {
          // Your tool logic here
          return { results: [] };
        },
      }),
    };
  }
}
```

Register it in `src/integrations/index.ts`:

```typescript
import { MyIntegration } from './my-integration.js';

export function registerAllIntegrations(): void {
  // ... existing registrations
  integrationRegistry.register(new MyIntegration());
}
```

## Tech Stack

- **[Vercel AI SDK 6](https://ai-sdk.dev/)** - ToolLoopAgent for agentic workflows
- **[Slack Bolt](https://slack.dev/bolt-js/)** - Slack app framework
- **[Zod](https://zod.dev/)** - Schema validation for tools
- **TypeScript** - Type safety throughout

## License

MIT
