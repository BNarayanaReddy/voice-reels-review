// Cloudflare Worker — judgments backend + audio proxy for the voice reviewer.
// Bindings (wrangler.toml): D1 as `DB`, R2 as `AUDIO`.
//
// Endpoints:
//   POST /api/judge   { id, verdict, reviewer }  -> records a judgment
//   GET  /api/judged                            -> { judged: [chunk ids] }
//   GET  /api/export                            -> { judgments: {id: final verdict} }
//   GET  /api/stats                             -> { stats: [...] }
//   GET  /audio/<key>                           -> streams R2 object with CORS

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS });
    }

    const url = new URL(request.url);

    // ---- audio proxy (R2) ----
    if (url.pathname.startsWith("/audio/")) {
      const key = url.pathname.slice("/audio/".length);
      if (!key) return json({ error: "bad key" }, 400);
      const obj = await env.AUDIO.get(key);
      if (!obj) return json({ error: "not found" }, 404);
      const ct = (obj.httpMetadata && obj.httpMetadata.contentType) || "audio/wav";
      return new Response(obj.body, {
        headers: {
          ...CORS,
          "Content-Type": ct,
          "Cache-Control": "public, max-age=31536000, immutable",
        },
      });
    }

    if (url.pathname === "/api/judge" && request.method === "POST") {
      try {
        const { id, verdict, reviewer, instagram, edited } = await request.json();
        if (!id || !["yes", "no", "skip"].includes(verdict)) {
          return json({ error: "bad request" }, 400);
        }
        await env.DB.prepare(
          "INSERT INTO judgments (chunk_id, verdict, reviewer, instagram_id, edited_transcript, ts) VALUES (?, ?, ?, ?, ?, ?)"
        ).bind(id, verdict, reviewer || "anon", instagram || null, edited || null, Date.now()).run();
        return json({ ok: true });
      } catch (e) {
        return json({ error: String(e) }, 500);
      }
    }

    if (url.pathname === "/api/judged") {
      const { results } = await env.DB.prepare(
        "SELECT DISTINCT chunk_id FROM judgments WHERE verdict IN ('yes','no')"
      ).all();
      return json({ judged: results.map((r) => r.chunk_id), count: results.length });
    }

    if (url.pathname === "/api/export") {
      const { results } = await env.DB.prepare(
        `SELECT chunk_id,
                SUM(CASE WHEN verdict='yes' THEN 1 ELSE 0 END) AS yes,
                SUM(CASE WHEN verdict='no'  THEN 1 ELSE 0 END) AS no
         FROM judgments GROUP BY chunk_id`
      ).all();
      const judgments = {};
      for (const r of results) {
        judgments[r.chunk_id] =
          r.yes === r.no ? "skip" : r.yes > r.no ? "yes" : "no";
      }
      return json({ judgments, count: results.length });
    }

    if (url.pathname === "/api/stats") {
      const { results } = await env.DB.prepare(
        "SELECT verdict, COUNT(*) AS n FROM judgments GROUP BY verdict"
      ).all();
      return json({ stats: results });
    }

    return json({ error: "not found" }, 404);
  },
};
