/**
 * Minimal type declarations for @deepseek-ai/dsh-tools (defineTool).
 * The package ships runtime JS only; this shim keeps the plugin self-contained.
 */
declare module '@deepseek-ai/dsh-tools' {
  export interface ToolRenderBlock {
    type: string;
    text?: string;
    [k: string]: unknown;
  }

  export interface ToolDefinition {
    name: string;
    description: string;
    parameters?: Record<string, unknown>;
    output?: {
      schema: unknown;
      render?: (args: any, value: any) => ToolRenderBlock[];
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    execute: (args: any) => unknown | Promise<unknown>;
  }

  export function defineTool<T extends ToolDefinition>(def: T): T;
}
