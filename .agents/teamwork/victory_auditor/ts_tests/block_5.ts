/**
 * Complete Execution Plan Definition
 */
export interface ExecutionPlan {
  readonly id: string;
  readonly version: string;
  readonly name: string;
  readonly domain?: string;
  readonly steps: PlanStep[];
  readonly settings: PlanExecutionSettings;
}

/** Utility: Extracts all ActionSteps in plan execution order */
export function getActionSteps(plan: ExecutionPlan): ActionStep[] {
  return plan.steps.filter((s): s is ActionStep => s.kind === 'action');
}

/** Utility: Extracts all FieldSteps in plan execution order */
export function getFieldSteps(plan: ExecutionPlan): FieldStep[] {
  return plan.steps.filter((s): s is FieldStep => s.kind === 'field');
}

export interface PlanExecutionSettings {
  readonly maxRounds: number;
  readonly settleTimeoutMs: number;
  readonly quietPeriodMs: number;
  readonly batchMode: boolean;
  readonly overwritePrefilled: boolean;
  readonly humanizeInteractions: boolean;
}

export type PlanStep = FieldStep | ActionStep;

export interface FieldStep {
  readonly id: string;
  readonly kind: 'field';
  readonly name: string;
  readonly valueType: 'string' | 'number' | 'boolean' | 'date' | 'select' | 'multi-select';
  readonly value: any;
  readonly locators: SemanticLocator[];
  readonly required?: boolean;
  readonly overwrite?: boolean;
  readonly waitFor?: string;
  readonly onlyIf?: StepCondition[];
  readonly source: 'user_input' | 'system_derived' | 'standard_default' | 'ai_suggested';
  readonly governanceLevel: 'auto_apply' | 'confirm_required' | 'manual_only';
  readonly metadata?: Record<string, unknown>;
}

export interface ActionStep {
  readonly id: string;
  readonly kind: 'action';
  readonly name: string;
  readonly actionType: 'click' | 'hover' | 'scroll' | 'submit' | 'navigate';
  readonly locators: SemanticLocator[];
  readonly afterSteps?: string[];
  readonly unlessPresent?: SemanticLocator;
  readonly verification: ActionVerification;
  readonly quietPeriodMs?: number;
  readonly maxTries?: number;
}

export type ActionVerification =
  | { type: 'element_appears'; locator: SemanticLocator }
  | { type: 'element_disappears'; locator: SemanticLocator }
  | { type: 'value_changes'; locator: SemanticLocator; expectedValue?: string }
  | { type: 'url_matches'; pattern: string | RegExp }
  | { type: 'network_idle'; timeoutMs: number };

export interface SemanticLocator {
  readonly strategy: LocatorStrategy;
  readonly primarySelector: string;
  readonly fallbacks?: FallbackLocator[];
  readonly relativeAnchor?: RelativeAnchor;
  readonly confidenceThreshold?: number;
}

export type LocatorStrategy =
  | 'semantic_attribute'
  | 'accessibility_tree'
  | 'text_label'
  | 'witness_relation'
  | 'structural_path';

export interface FallbackLocator {
  readonly strategy: LocatorStrategy;
  readonly selector: string;
  readonly priority: number;
}

export interface RelativeAnchor {
  readonly position: 'after' | 'before' | 'inside' | 'near';
  readonly referenceLocator: SemanticLocator;
  readonly maxDistancePx?: number;
}

/**
 * Conditional execution predicate evaluated prior to step execution.
 */
export interface StepCondition {
  /** Target source evaluated by the condition predicate */
  readonly target: 'field_value' | 'intake_fact' | 'environment' | 'custom_predicate';
  /** JSONPath or field identifier to evaluate (e.g. 'applicant.yearsInBusiness') */
  readonly path: string;
  /** Relational or logical comparison operator */
  readonly operator:
    | 'equals'
    | 'not_equals'
    | 'greater_than'
    | 'less_than'
    | 'in'
    | 'not_in'
    | 'contains'
    | 'is_truthy'
    | 'is_falsy'
    | 'matches_regex';
  /** Comparison operand value */
  readonly operand?: string | number | boolean | Array<string | number>;
  /** Custom JavaScript predicate snippet for complex conditions */
  readonly customPredicate?: {
    readonly language: 'javascript';
    readonly code: string;
  };
}

/**
 * Accessibility tree node representation conforming to W3C AccName and CDP specifications.
 */
export interface AccessibleNodeSummary {
  /** Chrome DevTools Protocol BackendNodeId or ephemeral DOM handle ID */
  readonly nodeId: number;
  /** WAI-ARIA role (e.g. 'textbox', 'combobox', 'button', 'checkbox', 'gridcell') */
  readonly role: string;
  /** Computed accessible name (derived from aria-label, aria-labelledby, or text content) */
  readonly name: string;
  /** Accessible description (derived from aria-describedby or title) */
  readonly description?: string;
  /** Current value of the accessible control */
  readonly value?: string | number;
  /** Boolean accessibility states */
  readonly states: {
    readonly disabled: boolean;
    readonly focused: boolean;
    readonly required: boolean;
    readonly invalid: boolean;
    readonly checked?: boolean | 'mixed';
    readonly expanded?: boolean;
    readonly readonly: boolean;
    readonly hidden: boolean;
  };
  /** Bounding box in CSS viewport coordinates */
  readonly boundingBox?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  /** Child accessibility node summaries if requested recursively */
  readonly children?: AccessibleNodeSummary[];
}

/**
 * Structured submission intercept event passed to audit and plugin hooks.
 */
export interface SubmissionEvent {
  /** Unique audit event identifier */
  readonly eventId: string;
  /** ISO-8601 UTC timestamp of the attempted submission action */
  readonly timestamp: string;
  /** Active session and workflow identifiers */
  readonly sessionId: string;
  readonly workflowId: string;
  /** Metadata describing the intercepted target element */
  readonly targetElement: {
    readonly tagName: string;
    readonly buttonText: string;
    readonly role: string;
    readonly primarySelector: string;
    readonly boundingBox?: {
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    };
  };
  /** Interaction type that attempted submission */
  readonly actionType: 'click' | 'submit_dispatch' | 'enter_key';
  /** High-risk security categories flagged by the core engine lexicon */
  readonly flaggedCategories: Array<
    'financial_binding' | 'third_party_report' | 'electronic_signature' | 'monetary_payment'
  >;
  /** Specific regex pattern that triggered the security guardrail */
  readonly matchedLexiconPattern?: string;
  /** Page context at moment of submission attempt */
  readonly pageContext: {
    readonly url: string;
    readonly title: string;
    readonly formSelector?: string;
  };
  /** Calling step identifier if triggered during plan execution */
  readonly triggeringStepId?: string;
}