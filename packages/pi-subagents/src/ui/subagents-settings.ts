// ---- Narrow interfaces ----

/** Narrow settings interface required by the subagents:settings command. */
export interface SubagentsSettingsManager {
  readonly maxConcurrent: number;
  readonly defaultMaxTurns: number | undefined;
  readonly graceTurns: number;
  applyMaxConcurrent(n: number): { message: string; level: "info" | "warning" };
  applyDefaultMaxTurns(n: number): { message: string; level: "info" | "warning" };
  applyGraceTurns(n: number): { message: string; level: "info" | "warning" };
}

/** Narrow UI interface — only the ctx.ui methods the settings handler calls. */
export interface SubagentsSettingsUI {
  select(title: string, options: string[]): Promise<string | undefined>;
  input(title: string, defaultValue?: string): Promise<string | undefined>;
  notify(message: string, level: "info" | "warning" | "error"): void;
}

// ---- Descriptor table ----

/** Describes one numeric setting's select label, prompt, validation, and apply behavior. */
interface NumericSettingDescriptor {
  /** Prefix used both to build the select option and to match the user's choice. */
  label: string;
  /** Current value rendered in the select option (e.g. "unlimited" for an unset default). */
  currentDisplay: (settings: SubagentsSettingsManager) => string | number;
  /** Title shown on the input prompt. */
  inputTitle: string;
  /** Value pre-filled into the input box. */
  inputDefault: (settings: SubagentsSettingsManager) => string;
  /** Minimum accepted integer, inclusive. */
  minimum: number;
  /** Warning shown when the parsed value is below the minimum. */
  validationMessage: string;
  /** Applies the validated value and returns the toast to display. */
  apply: (
    settings: SubagentsSettingsManager,
    n: number,
  ) => { message: string; level: "info" | "warning" };
}

const NUMERIC_SETTINGS: readonly NumericSettingDescriptor[] = [
  {
    label: "Max concurrency",
    currentDisplay: (settings) => settings.maxConcurrent,
    inputTitle: "Max concurrent background agents",
    inputDefault: (settings) => String(settings.maxConcurrent),
    minimum: 1,
    validationMessage: "Must be a positive integer.",
    apply: (settings, n) => settings.applyMaxConcurrent(n),
  },
  {
    label: "Default max turns",
    currentDisplay: (settings) => settings.defaultMaxTurns ?? "unlimited",
    inputTitle: "Default max turns before wrap-up (0 = unlimited)",
    inputDefault: (settings) => String(settings.defaultMaxTurns ?? 0),
    minimum: 0,
    validationMessage: "Must be 0 (unlimited) or a positive integer.",
    apply: (settings, n) => settings.applyDefaultMaxTurns(n),
  },
  {
    label: "Grace turns",
    currentDisplay: (settings) => settings.graceTurns,
    inputTitle: "Grace turns after wrap-up steer",
    inputDefault: (settings) => String(settings.graceTurns),
    minimum: 1,
    validationMessage: "Must be a positive integer.",
    apply: (settings, n) => settings.applyGraceTurns(n),
  },
];

// ---- Class ----

/**
 * Handler for the `/subagents:settings` slash command.
 *
 * Call `handle({ ui })` from the Pi command registration to open the interactive
 * settings list. Lifted from `AgentsMenuHandler.showSettings`.
 */
export class SubagentsSettingsHandler {
  constructor(private readonly settings: SubagentsSettingsManager) {}

  async handle({ ui }: { ui: SubagentsSettingsUI }): Promise<void> {
    const options = NUMERIC_SETTINGS.map(
      (d) => `${d.label} (current: ${d.currentDisplay(this.settings)})`,
    );
    const choice = await ui.select("Settings", options);
    if (!choice) return;

    const descriptor = NUMERIC_SETTINGS.find((d) => choice.startsWith(d.label));
    if (!descriptor) return;

    const val = await ui.input(descriptor.inputTitle, descriptor.inputDefault(this.settings));
    if (!val) return;

    const n = parseInt(val, 10);
    if (n >= descriptor.minimum) {
      const toast = descriptor.apply(this.settings, n);
      ui.notify(toast.message, toast.level);
    } else {
      ui.notify(descriptor.validationMessage, "warning");
    }
  }
}
