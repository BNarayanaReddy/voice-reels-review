// Reviewer site configuration — edit after Cloudflare setup.
window.CONFIG = {
  // Base URL of uploaded audio on Cloudflare R2 (trailing slash).
  AUDIO_BASE: "https://pub-279b543a6b394bd4bc52cb8be6435306.r2.dev/telugu-female-voice/",

  // Cloudflare Worker URL (judgments backend). Example:
  // "https://telugu-female-voice-review.YOUR-SUBDOMAIN.workers.dev"
  WORKER_URL: "https://telugu-female-voice-review.YOUR-WORKER.workers.dev",

  // Manifest lives next to this page (same origin).
  MANIFEST_URL: "manifest.json",
};
