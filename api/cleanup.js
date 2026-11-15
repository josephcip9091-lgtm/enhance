const { list, del } = require("@vercel/blob");

module.exports = async function handler(req, res) {
  try {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    const deleted = [];
    for (const prefix of ["enhanced/", "frames/", "inputs/"]) {
      let cursor;
      for (;;) {
        const page = await list({ prefix, cursor });
        for (const b of page.blobs) {
          if (new Date(b.uploadedAt).getTime() < cutoff) {
            await del(b.url);
            deleted.push(b.pathname);
          }
        }
        if (page.hasMore && page.cursor) cursor = page.cursor;
        else break;
      }
    }
    res.status(200).json({ deleted: deleted.length });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
};
