export const TASK_STATUS = Object.freeze({
  PENDING: "pending",
  QUEUED: "queued",
  RUNNING: "running",
  PAUSED: "paused",
  WAITING_USER: "waiting_user",
  BLOCKED: "blocked",
  COMPLETED: "completed",
  PARTIAL: "partial",
  FAILED: "failed",
  CANCELLED: "cancelled",
});

export const RESTARTABLE_STATUS = new Set([
  TASK_STATUS.QUEUED,
  TASK_STATUS.RUNNING,
  TASK_STATUS.PAUSED,
  TASK_STATUS.BLOCKED,
]);
