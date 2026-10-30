/**
 * Logging interface used by core. Each host provides an implementation
 * (VS Code: OutputChannel, CLI: stderr).
 *
 * Rules: code content and prompts are logged only at `trace`; API keys never.
 */
export type LogLevel = 'error' | 'warn' | 'info' | 'debug' | 'trace';

/** Ordered from least to most verbose. */
export const LOG_LEVELS: readonly LogLevel[] = ['error', 'warn', 'info', 'debug', 'trace'];

export interface Logger {
  error(message: string | Error, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  info(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
  trace(message: string, ...args: unknown[]): void;
}

/** True when a message at `level` should be written while the logger is set to `threshold`. */
export function isLevelEnabled(threshold: LogLevel, level: LogLevel): boolean {
  return LOG_LEVELS.indexOf(level) <= LOG_LEVELS.indexOf(threshold);
}

/** Logger that discards everything. Default for tests and callers that don't care. */
export const noopLogger: Logger = {
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
};
