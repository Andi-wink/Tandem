/**
 * Lightweight logger that suppresses debug/info output in production builds.
 * console.error and console.warn are always forwarded.
 */

const isDev = process.env.NODE_ENV !== 'production';

/* eslint-disable no-console */
export const logger = {
  /** Debug-level: only in development */
  debug: isDev ? console.debug.bind(console) : () => {},
  /** Info-level: only in development */
  info: isDev ? console.info.bind(console) : () => {},
  /** Alias for info */
  log: isDev ? console.log.bind(console) : () => {},
  /** Warnings: always shown */
  warn: console.warn.bind(console),
  /** Errors: always shown */
  error: console.error.bind(console),
};
/* eslint-enable no-console */
