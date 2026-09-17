import { appendFileSync } from "node:fs";

import {
  EXTENSION_ID,
  type PermissionSystemExtensionConfig,
} from "#src/config/extension-config";
import { maskCommandFields } from "./command-redaction";
import { capLogFieldWidths, resolveReviewLogFieldWidth } from "./log-field-cap";
import {
  OWNER_ONLY_FILE_MODE,
  restrictExistingPathToOwner,
} from "./log-file-permissions";
import { redactedJsonStringify } from "./log-redaction";

export interface PermissionSystemLogger {
  debug: (
    event: string,
    details?: Record<string, unknown>,
  ) => string | undefined;
  review: (
    event: string,
    details?: Record<string, unknown>,
  ) => string | undefined;
}

interface PermissionSystemLoggerOptions {
  getConfig: () => PermissionSystemExtensionConfig;
  debugLogPath: string;
  reviewLogPath: string;
  ensureLogsDirectory: () => string | undefined;
}

export function createPermissionSystemLogger(
  options: PermissionSystemLoggerOptions,
): PermissionSystemLogger {
  const { debugLogPath, reviewLogPath, ensureLogsDirectory } = options;
  // Per-session, so a log inherited from an earlier version is tightened once
  // rather than on every line. Lives in the closure because the factory is
  // re-invoked per session, unlike module scope, which now outlives one.
  const hardened = new Set<string>();

  /**
   * The transform stages every log line passes through, in the order they must
   * run.
   *
   * Command masking runs first, and it runs for both streams. Capping a command
   * before masking it would hand the masker a truncated command — a parse of
   * something the agent never ran — and the debug stream carries the same
   * payload as the review stream, so a mask that skipped it would only move the
   * exposure rather than close it.
   *
   * `maxFieldWidth` bounds every string the line carries; it is supplied for
   * the review stream and withheld for the debug stream, which is opt-in and
   * exists to be read in full. Capping happens before key-name redaction, which
   * masks by name and so still masks a sensitive value whole.
   */
  const prepareLogLine = (
    stream: "debug" | "review",
    event: string,
    details: Record<string, unknown>,
    maxFieldWidth?: number,
  ): string | undefined => {
    const masked = maskCommandFields(details);
    const bounded =
      maxFieldWidth === undefined
        ? masked
        : capLogFieldWidths(masked, maxFieldWidth);
    return redactedJsonStringify({
      timestamp: new Date().toISOString(),
      extension: EXTENSION_ID,
      stream,
      event,
      ...bounded,
    });
  };

  /** The only place a log line is produced. */
  const writeLine = (
    stream: "debug" | "review",
    path: string,
    event: string,
    details: Record<string, unknown>,
    maxFieldWidth?: number,
  ): string | undefined => {
    const directoryError = ensureLogsDirectory();
    if (directoryError) {
      return directoryError;
    }

    try {
      const line = prepareLogLine(stream, event, details, maxFieldWidth);
      if (!line) {
        return `Failed to write permission-system ${stream} log '${path}': event could not be serialized.`;
      }
      appendFileSync(path, `${line}\n`, {
        encoding: "utf-8",
        mode: OWNER_ONLY_FILE_MODE,
      });
      if (!hardened.has(path)) {
        hardened.add(path);
        restrictExistingPathToOwner(path, OWNER_ONLY_FILE_MODE);
      }
      return undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return `Failed to write permission-system ${stream} log '${path}': ${message}`;
    }
  };

  const debug = (
    event: string,
    details: Record<string, unknown> = {},
  ): string | undefined => {
    if (!options.getConfig().debugLog) {
      return undefined;
    }

    return writeLine("debug", debugLogPath, event, details);
  };

  const review = (
    event: string,
    details: Record<string, unknown> = {},
  ): string | undefined => {
    const config = options.getConfig();
    if (!config.permissionReviewLog) {
      return undefined;
    }

    return writeLine(
      "review",
      reviewLogPath,
      event,
      details,
      resolveReviewLogFieldWidth(config),
    );
  };

  return { debug, review };
}
