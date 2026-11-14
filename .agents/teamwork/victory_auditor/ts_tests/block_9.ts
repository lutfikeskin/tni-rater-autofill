export interface IDebugController {
  attach(target: { tabId?: number; wsEndpoint?: string }): Promise<void>;
  detach(): Promise<void>;
  getState(): "IDLE" | "RUNNING" | "PAUSED" | "STEPPING" | "HALTED" | "ERROR";

  pause(): Promise<void>;
  resume(): Promise<void>;
  stepOver(): Promise<void>;
  stepInto(): Promise<void>;
  stepTo(stepId: string): Promise<void>;

  setBreakpoint(bp: BreakpointDefinition): Promise<string>;
  removeBreakpoint(breakpointId: string): Promise<void>;

  evaluateExpression(expression: string): Promise<unknown>;
  getPartialAXTree(nodeId: number): Promise<AccessibleNodeSummary>;
  captureFrame(stepId: string): Promise<ExecutionFrame>;
}