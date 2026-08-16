/**
 * Minimal structural types for dsh-pack-maker. The plugin deliberately has
 * no runtime npm dependencies; DSH injects `ctx.tools` / `ctx.commands`.
 */

export interface ProfilePackConfig {
  outputDir?: string;
  autoInstall?: boolean;
  overwrite?: boolean;
}

export interface ToolLike {
  register(definition: Record<string, unknown>): unknown;
}

export interface CommandLike {
  register(definition: Record<string, unknown>): unknown;
}

export interface ProfilePackContext {
  tools: ToolLike;
  commands: CommandLike;
  effect(callback: () => unknown, label?: string): unknown;
}

export declare const name: 'dsh-pack-maker';
export declare const inject: ['tools', 'commands'];
export declare function apply(ctx: ProfilePackContext, config?: ProfilePackConfig): void;
