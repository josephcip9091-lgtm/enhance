const { handleUpload } = require("@vercel/blob/client");

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.status(204).end();
    return;
  }
  if (req.method !== "POST") {
    res.status(405).json({ error: "POST only" });
    return;
  }
  let raw = "";
  req.on("data", (c) => { raw += c; if (raw.length > 1e6) req.destroy(); });
  req.on("end", async () => {
    let event;
    try { event = JSON.parse(raw); } catch (e) {
      res.status(400).json({ error: "Bad JSON" });
      return;
    }
    try {
      const pathname = event && event.payload && event.payload.pathname;
      if (!pathname || !pathname.startsWith("inputs/")) {
        res.status(400).json({ error: "Bad pathname" });
        return;
      }
      const json = await handleUpload({
        request: req,
        body: event,
        onBeforeGenerateToken: async (p) => ({
          allowedContentTypes: ["video/*"],
          maximumSizeInBytes: 450 * 1024 * 1024,
        }),
        onUploadCompleted: async () => {},
      });
      res.status(200).json(json);
    } catch (err) {
      res.status(400).json({ error: String(err.message || err) });
    }
  });
};
