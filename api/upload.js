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
  try {
    const pathname = String(req.query.pathname || "");
    if (!pathname.startsWith("inputs/")) {
      res.status(400).json({ error: "Bad pathname" });
      return;
    }
    const json = await handleUpload({
      request: req,
      pathname,
      onBeforeGenerateToken: async (p) => ({ allowedContentTypes: ["video/*"], maximumSizeInBytes: 450 * 1024 * 1024, addRandomSuffix: false }),
      onUploadCompleted: async () => {},
    });
    res.status(200).json(json);
  } catch (err) {
    res.status(400).json({ error: String(err.message || err) });
  }
};
