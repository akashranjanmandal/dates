// Local stand-in for Netlify Blobs (used by `npm run dev` and by tests).
//
// The stock local sandbox checks-then-writes in separate steps and tags versions with millisecond
// timestamps, so two simultaneous conditional writes can both succeed. Netlify's real service makes
// them atomic; this mirrors that so concurrency bugs show up locally instead of in production.
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { BlobsServer } from "@netlify/blobs/server";

let patched = false;
function patch() {
  if (patched) return;
  patched = true;
  let chain = Promise.resolve();
  const rawPut = BlobsServer.prototype.put;
  BlobsServer.prototype.put = function (req) {
    const run = chain.then(() => rawPut.call(this, req));
    chain = run.catch(() => {});
    return run;
  };
  // Version tags from the file's content: identical only when the content is identical, so a stale
  // writer can never be mistaken for an up-to-date one (timestamps/inodes can repeat).
  BlobsServer.generateETag = async (filePath) => {
    try { return `"${createHash("sha256").update(await readFile(filePath)).digest("hex")}"`; } catch { return ""; }
  };
}

export async function startLocalBlobs({ directory, port }) {
  patch();
  await mkdir(directory, { recursive: true });
  await new BlobsServer({ directory, token: "local", port }).start();
  const edge = `http://localhost:${port}`;
  process.env.NETLIFY_BLOBS_CONTEXT = Buffer.from(JSON.stringify({ siteID: "local", token: "local", edgeURL: edge, uncachedEdgeURL: edge })).toString("base64");
}
