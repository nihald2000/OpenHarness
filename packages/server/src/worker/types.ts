import type { RunMode, RunPhase, RunRecord, RunStatus } from "@openharness/sdk";

export interface FrozenRunSnapshot {
  model: string;
  promptVersion: string;
  tools: string[];
  limits: {
    maxIterations: number;
    maxFixAttempts: number;
    maxQuestions: number;
    firstActivityTimeoutMs: number;
    toolTimeoutMs: number;
    stallTimeoutMs: number;
  };
}

export interface QuestionRequest {
  questionId: string;
  question: string;
  options?: string[];
  callId?: string;
  askedAt: number;
  answeredAt?: number;
  answer?: string;
}

export interface ErrorDiagnostic {
  code:
    | "AUTH_ERROR"
    | "RATE_LIMIT"
    | "QUOTA_EXCEEDED"
    | "CONTEXT_OVERFLOW"
    | "SANDBOX_BOOT_FAILED"
    | "SANDBOX_UNAVAILABLE"
    | "FIRST_ACTIVITY_TIMEOUT"
    | "TOOL_TIMEOUT"
    | "RUN_STALLED"
    | "TOOL_LOOP"
    | "CANCELLED"
    | "INTERNAL_ERROR";
  message: string;
  recoverable: boolean;
  detail?: string;
}

export interface DurableRunRecord extends RunRecord {
  prompt: string;
  agent: string;
  runtime?: string;
  clientTurnId?: string;
  snapshot: FrozenRunSnapshot;
  pendingQuestion?: QuestionRequest | null;
  questionsAsked: number;
  lastHeartbeatAt: number;
  firstActivityAt?: number;
  changedFiles: string[];
  previewUrl?: string;
  diagnostic?: ErrorDiagnostic;
}

export interface CreateRunInput {
  runId?: string;
  sessionId: string;
  tenantId?: string;
  prompt: string;
  agent?: string;
  model: string;
  runtime?: string;
  mode?: RunMode;
  clientTurnId?: string;
  tools?: string[];
  limits?: Partial<FrozenRunSnapshot["limits"]>;
}

export interface RunWorker {
  enqueueAndStart(input: CreateRunInput): Promise<{ run: DurableRunRecord; deduplicated: boolean }>;
  startRun(runId: string): Promise<void>;
  cancelRun(runId: string, reason?: string): Promise<DurableRunRecord | null>;
  answerQuestion(runId: string, answer: string): Promise<DurableRunRecord>;
  retryRun(runId: string): Promise<DurableRunRecord>;
  getRun(runId: string): Promise<DurableRunRecord | null>;
}

export type { RunMode, RunPhase, RunStatus };
