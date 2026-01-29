import type { KnownBlock } from '@slack/web-api';

export interface CommandContext {
  userId?: string;
  teamId?: string;
  channelId?: string;
  threadTs?: string;
}

export interface CommandResponse {
  text: string;
  blocks?: KnownBlock[];
}

export interface Command {
  name: string;
  description: string;
  aliases?: string[];
  execute: (args: string, context: CommandContext) => Promise<CommandResponse>;
}

export class CommandRegistry {
  private commands = new Map<string, Command>();
  private aliases = new Map<string, string>();

  register(command: Command) {
    this.commands.set(command.name, command);
    if (command.aliases) {
      for (const alias of command.aliases) {
        this.aliases.set(alias, command.name);
      }
    }
  }

  async execute(text: string, context: CommandContext = {}): Promise<CommandResponse | null> {
    const trimmed = text.trim();
    if (!trimmed) {
      return null;
    }

    const firstSpace = trimmed.indexOf(' ');
    const commandName = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).toLowerCase();
    const args = firstSpace === -1 ? '' : trimmed.slice(firstSpace + 1).trim();

    // Check direct match
    if (this.commands.has(commandName)) {
      return this.commands.get(commandName)!.execute(args, context);
    }

    // Check alias
    if (this.aliases.has(commandName)) {
      const realName = this.aliases.get(commandName)!;
      return this.commands.get(realName)!.execute(args, context);
    }

    // Handle "oauth status" type multi-word commands if needed, 
    // but for now let's stick to simple single-word dispatch or leave complex logic to commands themselves.
    // However, existing "oauth status" was handled by regex. 
    // Let's support a "catch-all" or regex-based commands if strictly strict dispatch isn't enough.
    // For now, let's keep it simple: specific commands are registered. 
    // If we want "oauth status", we can register "oauth" command and it handles "status" arg.

    return null;
  }

  getCommands(): Command[] {
    return Array.from(this.commands.values());
  }
}

export const commandRegistry = new CommandRegistry();
