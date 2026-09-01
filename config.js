// Reviewer site configuration — edit after Cloudflare Worker is deployed.
window.CONFIG = {
  // Cloudflare Worker URL (judgments backend + audio proxy). Example:
  // "https://telugu-female-voice-review.YOUR-SUBDOMAIN.workers.dev"
  WORKER_URL: "https://telugu-female-voice-review.YOUR-WORKER.workers.dev",

  // Manifest lives next to this page (same origin).
  MANIFEST_URL: "manifest.json",
};
