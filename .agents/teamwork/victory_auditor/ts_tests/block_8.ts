/**
 * Workflow IR Schema (v2.0.0)
 */
export type UUID = string;

export interface WorkflowDefinitionIR {
  readonly irVersion: "2.0.0";
  readonly id: UUID;
  readonly name: string;
  readonly description?: string;
  readonly version: string;
  readonly author?: string;
  readonly tags?: string[];

  readonly scope: {
    readonly matchUrls: string[];
    readonly excludedUrls?: string[];
    readonly allowedOrigins: string[];
    readonly requiredPermissions?: string[];
  };

  readonly schema: {
    readonly inputs: JSONSchemaDraft7;
    readonly outputs?: JSONSchemaDraft7;
  };

  readonly defaults: {
    readonly timeoutMs: number;
    readonly quietPeriodMs: number;
    readonly maxRetries: number;
    readonly retryIntervalMs: number;
    readonly screenshotOnFailure: boolean;
  };

  readonly studioMetadata?: {
    readonly canvasNodes: Record<UUID, { x: number; y: number; group?: string }>;
    readonly comments: Record<UUID, string>;
  };

  readonly hooks?: WorkflowHooksIR;
  readonly steps: WorkflowStepIR[];
}

export type WorkflowStepIR =
  | NavigateStepIR
  | FillFieldStepIR
  | ClickActionStepIR
  | WaitStepIR
  | ExtractDataStepIR
  | ConditionalBranchStepIR
  | LoopStepIR
  | SubWorkflowStepIR
  | CustomCodeStepIR;

export interface BaseStepIR {
  readonly id: UUID;
  readonly name: string;
  readonly comment?: string;
  readonly enabled: boolean;
  readonly continueOnError?: boolean;
  readonly timeoutMs?: number;
}

export type ValueBindingSource =
  | "input"
  | "constant"
  | "derived"
  | "standard"
  | "env"
  | "expression";

export interface ExpressionBindingIR {
  /** Target programming language of the raw expression */
  readonly language: "javascript" | "python";
  /** Raw textual source code of the lambda / expression (e.g. `(ctx) => ctx.input.legalName.toUpperCase()`) */
  readonly code: string;
  /**
   * Serialized AST subtree (e.g. Babel AST node or Python AST dict).
   * Preserves AST trivia, original formatting hints, whitespace, and comments for 100% round-trip fidelity.
   */
  readonly astJson?: Record<string, unknown>;
  /** Static return type declaration for Visual Studio formula bar validation */
  readonly returnType?: "string" | "number" | "boolean" | "date" | "unknown";
  /** Explicit list of input fact paths read by this expression (extracted via static AST analysis) */
  readonly dependencies?: string[];
}

export interface ValueBindingIR {
  readonly source: ValueBindingSource;
  /** Dot-delimited JSONPath or property path into intake facts when source === 'input' | 'derived' */
  readonly path?: string;
  /** Static primitive constant when source === 'constant' */
  readonly constant?: string | number | boolean;
  /** Standard formatting transform applied to declarative paths */
  readonly formatTransform?: "trim" | "currency" | "digits-only" | "uppercase" | "date-iso";
  /** Sandboxed script snippet or raw AST snippet when source === 'expression' */
  readonly expression?: ExpressionBindingIR;
}

export interface FillFieldStepIR extends BaseStepIR {
  readonly kind: "fillField";
  readonly locator: SemanticLocatorIR;
  readonly valueBinding: ValueBindingIR;
  readonly fieldKind: "text" | "radio" | "checkbox" | "select" | "combobox";
  readonly strategy: {
    readonly clearBeforeTyping: boolean;
    readonly keystrokeDelayMs?: number;
    readonly dispatchEvents: Array<"input" | "change" | "blur">;
    readonly verification: "value-equals" | "visual-mark" | "none";
    readonly replaceExisting: boolean;
  };
}

export interface ClickActionStepIR extends BaseStepIR {
  readonly kind: "clickAction";
  readonly locator: SemanticLocatorIR;
  readonly interaction: "click" | "doubleClick" | "hover";
  readonly postWait: {
    readonly type: "settle" | "navigation" | "element-visible" | "none";
    readonly quietPeriodMs?: number;
  };
  readonly guardrails: {
    readonly blockDestructiveSubmissions: boolean;
  };
}

export interface SemanticLocatorIR {
  readonly id: string;
  readonly description: string;
  readonly accessibility?: {
    readonly role: string;
    readonly name?: string;
    readonly description?: string;
  };
  readonly attributes?: {
    readonly dataTestId?: string;
    readonly fieldRef?: string;
    readonly name?: string;
    readonly idPattern?: string;
  };
  readonly anchor?: {
    readonly nearText?: string;
    readonly direction?: "right-of" | "below" | "inside";
  };
  readonly selectors: string[];
  readonly shadowPath?: string[];
  readonly frameSelector?: string;
}