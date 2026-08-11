import { randomUUID } from "node:crypto";

/**
 * Registry of in-flight background uploads.
 *
 * WHY THIS EXISTS: an MCP client gives up on a tool call after 60 seconds
 * (`DEFAULT_REQUEST_TIMEOUT_MSEC` in the SDK), and nothing the server sends can reliably extend
 * that — progress notifications only reset the clock when the client opted in with
 * `resetTimeoutOnProgress`, which is false by default. A 400 MiB upload cannot finish inside
 * that budget on any ordinary connection, so a tool call must not be the thing waiting for it.
 *
 * Instead a large upload is started, registered here, and reported on by the `upload_status`
 * tool — the same shape the product already uses for rename/move/delete, which return a queue
 * `RequestId` and complete in the background.
 *
 * Scope: in-memory, and deliberately so. This is only reachable over stdio, where the server is
 * a long-lived single-user process. If that process restarts mid-upload the job is lost and S3
 * is left holding an incomplete multipart upload — S3 lifecycle rules are the normal way to
 * expire those. The hosted transport never gets here: it uploads inline and synchronously.
 */

export type UploadState = "running" | "completed" | "failed";

export interface UploadJob {
  id: string;
  bucketName: string;
  /** The name the object is actually stored under (may differ from what was asked for). */
  fileName: string;
  key: string;
  sizeBytes: number;
  partSize: number;
  totalParts: number;
  completedParts: number;
  bytesUploaded: number;
  state: UploadState;
  /** Set when state is "failed" — the reason, already secret-free. */
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

/** Keep a bounded history so a long-running server cannot grow without limit. */
const MAX_TRACKED = 50;

const jobs = new Map<string, UploadJob>();

/** Drop the oldest finished jobs once the map outgrows MAX_TRACKED. Running jobs are never
 *  evicted — losing the handle to an upload still in progress would strand it. */
function evictOldFinished(): void {
  if (jobs.size <= MAX_TRACKED) return;
  const finished = [...jobs.values()]
    .filter((job) => job.state !== "running")
    .sort((a, b) => (a.finishedAt ?? a.startedAt) - (b.finishedAt ?? b.startedAt));
  for (const job of finished) {
    if (jobs.size <= MAX_TRACKED) break;
    jobs.delete(job.id);
  }
}

export function createJob(
  init: Pick<UploadJob, "bucketName" | "fileName" | "key" | "sizeBytes" | "partSize" | "totalParts">,
): UploadJob {
  const job: UploadJob = {
    id: `up_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
    ...init,
    completedParts: 0,
    bytesUploaded: 0,
    state: "running",
    startedAt: Date.now(),
  };
  jobs.set(job.id, job);
  evictOldFinished();
  return job;
}

export function getJob(id: string): UploadJob | undefined {
  return jobs.get(id);
}

/** Newest first — what `upload_status` shows when asked for no particular id. */
export function listJobs(): UploadJob[] {
  return [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
}

export function recordPart(id: string, bytes: number): void {
  const job = jobs.get(id);
  if (!job) return;
  job.completedParts += 1;
  job.bytesUploaded += bytes;
}

export function finishJob(id: string, error?: string): void {
  const job = jobs.get(id);
  if (!job) return;
  job.state = error ? "failed" : "completed";
  if (error) job.error = error;
  job.finishedAt = Date.now();
  evictOldFinished();
}

/** Reset between tests. Not used at runtime. */
export function clearJobs(): void {
  jobs.clear();
}
