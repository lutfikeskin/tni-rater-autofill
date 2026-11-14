/**
 * Universal browser abstraction port decoupling the core execution
 * engine from the underlying runtime substrate.
 */
export interface ExecutionTarget {
  readonly runtimeType: 'mv3' | 'playwright' | 'puppeteer' | 'cdp';
  readonly capabilities: TargetCapabilities;

  // Session & Navigation Lifecycle
  getCurrentUrl(): Promise<string>;
  getTitle(): Promise<string>;
  waitForNavigation(options?: NavigationOptions): Promise<void>;

  // Element Querying & Resolution
  collectElements(selector: string, root?: ElementHandle): Promise<ElementHandle[]>;
  getAccessibilityNode(handle: ElementHandle): Promise<AccessibleNodeSummary>;
  evaluateScript<T>(script: string | ((...args: any[]) => T), ...args: any[]): Promise<T>;

  // Human-Like Interaction Port
  click(handle: ElementHandle, options?: ClickOptions): Promise<void>;
  type(handle: ElementHandle, text: string, options?: TypeOptions): Promise<void>;
  selectOption(handle: ElementHandle, values: string[]): Promise<SelectionResult>;
  hover(handle: ElementHandle): Promise<void>;
  scrollIntoView(handle: ElementHandle): Promise<void>;

  // Stability & Network Monitoring Port
  waitForQuiet(options: SettleOptions): Promise<SettleResult>;
  getInFlightRequests(): Promise<InFlightRequestSummary>;

  // Co-Pilot Security & Interception Port
  installUserGestureGuard(onEditDetected: (key: string) => void): Promise<() => void>;
}

export interface TargetCapabilities {
  supportsCDP: boolean;
  supportsHardwareInput: boolean;
  supportsClosedShadowDOM: boolean;
  supportsTimeTravel: boolean;
}