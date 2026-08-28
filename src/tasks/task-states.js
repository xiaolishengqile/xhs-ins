export const TASK_STATUS = Object.freeze({
  QUEUED: "queued",
  RUNNING: "running",
  WAITING_USER: "waiting_user",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
});

export const RESTARTABLE_STATUS = new Set([
  TASK_STATUS.QUEUED,
  TASK_STATUS.RUNNING,
]);
