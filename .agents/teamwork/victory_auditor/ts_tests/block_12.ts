export interface PluginContext {
  /** Registered plugin ID and semantic version from module.json */
  readonly pluginId: string;
  readonly pluginVersion: string;
  /** Enterprise tenant organization identifier */
  readonly organizationId: string;
  /** Runtime environment profile */
  readonly environment: 'production' | 'staging' | 'development' | 'testing';
  /** Immutable configuration parameters defined in tenant profile */
  readonly config: Readonly<Record<string, unknown>>;
  /** Sandboxed structured logger emitting to OpenTelemetry audit stream */
  readonly logger: {
    info(message: string, context?: Record<string, unknown>): void;
    warn(message: string, context?: Record<string, unknown>): void;
    error(message: string, error?: Error, context?: Record<string, unknown>): void;
  };
  /** List of security capability permissions granted to this plugin */
  readonly permissions: ReadonlyArray<string>;
}

export interface ReadonlySubmissionEvent {
  readonly stepId: string;
  readonly targetElementSummary: {
    readonly tagName: string;
    readonly textContent: string;
    readonly matchedSurfaces: readonly string[];
  };
  readonly detectedCategory?: 'SIGNATURE' | 'BINDING' | 'PAYMENT' | 'REPORT' | 'MULTILINGUAL';
  readonly triggeredLexiconPattern?: string;
  readonly timestamp: number;
}

export interface ReadonlyStepView {
  readonly id: string;
  readonly name: string;
  readonly kind: 'field' | 'action';
  readonly valueType?: string;
  readonly expectedValue?: unknown;
  readonly governanceLevel: 'auto_apply' | 'confirm_required' | 'manual_only';
  readonly readOnlyLocators: readonly Readonly<{
    strategy: string;
    primarySelector: string;
  }>[];
  readonly metadata: Readonly<Record<string, unknown>>;
}

export function deepFreeze<T>(obj: T, visited = new WeakSet<object>()): Readonly<T> {
  if (obj === null || typeof obj !== 'object' || visited.has(obj)) {
    return obj;
  }
  visited.add(obj);
  const propNames = Object.getOwnPropertyNames(obj);
  for (const name of propNames) {
    const value = (obj as Record<string, unknown>)[name];
    if (value && typeof value === 'object') {
      deepFreeze(value, visited);
    }
  }
  return Object.freeze(obj);
}

export function createReadonlyStepView(step: FieldStep | ActionStep): ReadonlyStepView {
  const locators = step.locators.map(loc =>
    Object.freeze({
      strategy: loc.strategy,
      primarySelector: loc.primarySelector
    })
  );

  return deepFreeze({
    id: step.id,
    name: step.name,
    kind: step.kind,
    valueType: step.kind === 'field' ? step.valueType : undefined,
    expectedValue: step.kind === 'field' ? step.value : undefined,
    governanceLevel: step.kind === 'field' ? step.governanceLevel : 'auto_apply',
    readOnlyLocators: Object.freeze(locators),
    metadata: step.metadata ? { ...step.metadata } : {}
  });
}

export interface EnterprisePluginHooks {
  /** Invoked when module is loaded into sandboxed worker */
  onInitialize?(context: PluginContext): Promise<void>;

  /**
   * Invoked prior to interacting with a specific DOM control.
   * Receives an immutable, deep-frozen DTO. Plugins CANNOT mutate governanceLevel or locators.
   */
  beforeStepExecute?(step: ReadonlyStepView): Promise<'proceed' | 'skip' | 'defer'>;

  /** Invoked immediately after a DOM control has been updated and value retained */
  afterStepExecute?(
    step: ReadonlyStepView,
    result: Readonly<{ success: boolean; appliedValue: unknown }>
  ): Promise<void>;

  /**
   * CRITICAL RESTRICTIVE HOOK:
   * Plugins CANNOT permit an action blocked by the core engine.
   * Can return 'block_and_alert' to veto an action, or 'no_objection' to defer to core engine.
   * Returning 'allow' is syntactically impossible.
   */
  onSubmissionValidation?(
    event: ReadonlySubmissionEvent
  ): Promise<'no_objection' | 'block_and_alert'>;

  /** Invoked upon workflow conclusion or termination */
  onWorkflowComplete?(report: WorkflowReport): Promise<void>;
}