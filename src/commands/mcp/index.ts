import type { Command } from 'commander';
import { registerMcpConnectCommand } from './connect.js';
import { registerMcpDisconnectCommand } from './disconnect.js';

export function registerMcpCommands(program: Command): void {
  registerMcpConnectCommand(program);
  registerMcpDisconnectCommand(program);
}
