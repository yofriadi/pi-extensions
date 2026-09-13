import { parseMaxRetries } from "./config.ts";
import type { RetryLimit } from "./types.ts";

/**
 * Formats a retry limit (either attempts count or duration) to a human-readable string.
 * Examples: "3 attempt(s)", "5h (18000000 ms)", "15m (900000 ms)"
 */
export function formatMaxRetries(limit: RetryLimit | number | string): string {
  const resolved =
    typeof limit === "object" && limit !== null && "type" in limit
      ? limit
      : parseMaxRetries(limit);

  if (resolved.type === "attempts") {
    return `${resolved.count} attempt(s)`;
  }
  return `${formatDuration(resolved.durationMs)} (${resolved.durationMs} ms)`;
}

/**
 * Formats a duration in milliseconds to a human-readable string.
 * Examples: "45s", "3m 12s", "1h 30m", "5h"
 */
export function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const totalSeconds = Math.round(ms / 1000);

  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes < 60) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  if (remainingMinutes === 0) {
    return `${hours}h`;
  }

  return `${hours}h ${remainingMinutes}m`;
}

/**
 * Formats a delay duration in a compact representation for logs.
 * Examples: "500ms", "5s", "1.5m", "1h"
 */
export function formatDelay(ms: number): string {
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  if (ms < 60000) {
    const s = Math.round(ms / 100) / 10;
    return `${s}s`;
  }
  if (ms < 3600000) {
    const m = Math.round(ms / 6000) / 10;
    return `${m}m`;
  }
  const h = Math.round((ms / 3600000) * 10) / 10;
  return `${h}h`;
}

/**
 * Truncates and cleans error message strings for single-line UI notifications.
 */
export function truncateErrorMessage(error?: string, maxLength = 120): string {
  if (!error) return "Unknown error";
  const singleLine = error.replace(/\r?\n|\r/g, " ").replace(/\s+/g, " ").trim();
  if (singleLine.length <= maxLength) {
    return singleLine;
  }
  return singleLine.slice(0, maxLength - 3) + "...";
}

/**
 * Formats a Date or millisecond timestamp to zero-padded local time "HH:MM:SS".
 * Example: "11:29:28"
 */
export function formatTime(date: Date | number = new Date()): string {
  const d = typeof date === "number" ? new Date(date) : date;
  const hours = String(d.getHours()).padStart(2, "0");
  const minutes = String(d.getMinutes()).padStart(2, "0");
  const seconds = String(d.getSeconds()).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

/**
 * Formats a Date or millisecond timestamp to local "YYYY-MM-DD HH:MM:SS".
 * Example: "2026-09-02 11:29:28"
 */
export function formatDateTime(date: Date | number = new Date()): string {
  const d = typeof date === "number" ? new Date(date) : date;
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const time = formatTime(d);
  return `${year}-${month}-${day} ${time}`;
}
