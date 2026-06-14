import { formatDate } from "../api/http.js";

export default function TransferJobsPanel({ jobs }) {
  if (!jobs.length) return null;
  return (
    <section className="transfer-jobs-panel">
      <div className="section-heading"><h2>Background transfers</h2><span>{jobs.filter((job) => ["queued", "running"].includes(job.status)).length} active</span></div>
      <div className="transfer-job-list">
        {jobs.slice(0, 8).map((job) => (
          <article className={`transfer-job transfer-job--${job.status}`} key={job.id}>
            <div><strong>{job.operation === "move" ? "Move" : "Copy"}: {job.path}</strong><span>To {job.destinationRootId}:/{job.destinationPath}</span></div>
            <div><strong>{job.status}</strong><span>{job.error || formatDate(job.completedAt || job.createdAt)}</span></div>
          </article>
        ))}
      </div>
    </section>
  );
}
