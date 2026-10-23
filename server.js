

/*
 * ForkScore server — Powered by MongoDB.
 *
 *   npm start            then open http://localhost:3000
 *
 * Settings (environment variables)
 *   PORT         default 3000
 *   ADMIN_KEY    turns on review removal; send it as the x-admin-key header
 *   TRUST_PROXY  set to 1 when behind a host proxy (Render, Railway, ...), so spam
 *                limits use each visitor's real address
 */
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { MongoClient, ObjectId } = require("mongodb");

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const TRUST_PROXY = process.env.TRUST_PROXY === "1";

// Embedded Atlas connection string to completely prevent Windows terminal conflicts
const MONGODB_URI = "mongodb+srv://joakola2009_db_user:joakola2009_db_user@cluster0.cs6i1kz.mongodb.net/forkscore?retryWrites=true&w=majority";


const MAX_BODY_BYTES = 10 * 1024;
const MAX_LIVE_CONNECTIONS = 2000;
const RATE_LIMIT = { windowMs: 60_000, max: 5 }; // 5 new reviews per minute per visitor
const LIMITS = { restaurant: 80, reviewer: 60, text: 1000 };

// Only these files are ever served, so server.js stays private.
const STATIC_FILES = {
  "/": "index.html",
  "/index.html": "index.html",
  "/style.css": "style.css",
  "/script.js": "script.js",
  "/restaurants-by-country.js": "restaurants-by-country.js",
  "/restaurant-photos.js": "restaurant-photos.js"
};
const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8"
};
function reviewHTML(review, showRestaurant) {
  return `
    <article class="review-item${freshIds.has(review.id) ? " fresh" : ""}">
      <div class="review-top">
        <strong>${escapeHTML(review.reviewer)}</strong>
        <span class="stars" role="img" aria-label="${review.rating} out of 5 stars">${stars(review.rating)}</span>
      </div>
      ${showRestaurant ? `<p class="review-for">${escapeHTML(review.restaurant)}</p>` : ""}
      <p class="review-text">${escapeHTML(review.text)}</p>
      <div style="display: flex; align-items: center; justify-content: space-between; margin-top: 12px;">
        <time datetime="${escapeHTML(review.createdAt)}">${escapeHTML(timeAgo(review.createdAt))}</time>
        <button class="report-btn" data-report-id="${review.id}" title="Report this review as spam" style="border: 0; background: transparent; padding: 4px; font-size: 0.95rem; cursor: pointer; color: var(--muted);">🚩</button>
      </div>
    </article>`;
}

/* ---------- MongoDB Database Setup ---------- */

let dbClient = null;
let reviewsCollection = null;

async function connectDatabase() {
  try {
  const directCleanUri = "mongodb+srv://forkscore_admin:LagosFood2026@cluster0.cs6i1kz.mongodb.net/forkscore?retryWrites=true&w=majority";

    dbClient = new MongoClient(directCleanUri);
    await dbClient.connect();
    const db = dbClient.db();
    reviewsCollection = db.collection("reviews");

    // Create an index on createdAt to optimize fetching latest reviews faster
    await reviewsCollection.createIndex({ createdAt: 1 });
    console.log("Connected successfully to MongoDB");
  } catch (error) {
    console.error("Failed to connect to MongoDB:", error.message);
    process.exit(1);
  }
}


/* ---------- Live stream (Server-Sent Events) ---------- */

const streams = new Set();

function openStream(req, res) {
  if (streams.size >= MAX_LIVE_CONNECTIONS) {
    return sendJson(res, 503, { error: "Too many live connections. Try again shortly." });
  }
  req.socket.setTimeout(0);
  req.socket.setNoDelay(true);
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.write("retry: 3000\n\n");
  streams.add(res);
  req.on("close", () => streams.delete(res));
}

function broadcast(event, data) {
  const frame = "event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n";
  for (const stream of streams) stream.write(frame);
}

// A small ping every 25s stops hosts and browsers from closing quiet connections.
setInterval(() => {
  for (const stream of streams) stream.write(": ping\n\n");
}, 25_000).unref();

/* ---------- Helpers ---------- */

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(payload);
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", chunk => {
      size += chunk.length;
      if (size <= MAX_BODY_BYTES) chunks.push(chunk);
      else if (size > MAX_BODY_BYTES * 10) req.destroy();
    });
    req.on("end", () => {
      if (size > MAX_BODY_BYTES) return reject(httpError(413, "That review is too large."));
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        reject(httpError(400, "The request was not valid JSON."));
      }
    });
    req.on("error", reject);
  });
}

// Remove control characters and tidy whitespace.
function clean(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function clientIp(req) {
  if (TRUST_PROXY) {
    const forwarded = String(req.headers["x-forwarded-for"] || "").split(",");
    const last = forwarded[forwarded.length - 1].trim(); // the address the host's proxy saw
    if (last) return last;
  }
  return req.socket.remoteAddress || "unknown";
}

const recentPosts = new Map();
function isRateLimited(ip) {
  const now = Date.now();
  const recent = (recentPosts.get(ip) || []).filter(time => now - time < RATE_LIMIT.windowMs);
  if (recent.length >= RATE_LIMIT.max) {
    recentPosts.set(ip, recent);
    return true;
  }
  recent.push(now);
  recentPosts.set(ip, recent);
  return false;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, times] of recentPosts) {
    if (!times.some(time => now - time < RATE_LIMIT.windowMs)) recentPosts.delete(ip);
  }
}, 60_000).unref();

/* ---------- Routes ---------- */

async function getReviews(req, res) {
  try {
    const databaseReviews = await reviewsCollection.find({}).toArray();
    const formattedReviews = databaseReviews.map(r => ({
      id: r._id.toString(),
      restaurant: r.restaurant,
      reviewer: r.reviewer,
      rating: r.rating,
      text: r.text,
      createdAt: r.createdAt
    }));
    sendJson(res, 200, { reviews: formattedReviews });
  } catch (error) {
    sendJson(res, 500, { error: "Failed to retrieve reviews from the database." });
  }
}

async function createReview(req, res) {
  const body = await readJson(req);

  const restaurant = clean(body.restaurant);
  const reviewer = clean(body.reviewer);
  const text = clean(body.text);
  const rating = Number(body.rating);

  if (!restaurant || !reviewer || !text) {
    return sendJson(res, 400, { error: "Please fill in the restaurant, your name and your review." });
  }
  if (restaurant.length > LIMITS.restaurant || reviewer.length > LIMITS.reviewer || text.length > LIMITS.text) {
    return sendJson(res, 400, { error: "One of the fields is too long." });
  }
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
    return sendJson(res, 400, { error: "Please choose a rating from 1 to 5 stars." });
  }

  // Stops an accidental double-tap from posting the same review twice.
  const tenMinutesAgo = new Date(Date.now() - 10 * 60_000).toISOString();
  const isDuplicate = await reviewsCollection.findOne({
    restaurant,
    reviewer,
    text,
    createdAt: { $gt: tenMinutesAgo }
  });

  if (isDuplicate) {
    return sendJson(res, 409, { error: "That review has already been posted." });
  }

  if (isRateLimited(clientIp(req))) {
    return sendJson(res, 429, { error: "You're posting very quickly. Please wait a minute and try again." });
  }

  const reviewDocument = {
    restaurant,
    reviewer,
    rating,
    text,
    createdAt: new Date().toISOString()
  };

  const result = await reviewsCollection.insertOne(reviewDocument);
  
  const publicReview = {
    id: result.insertedId.toString(),
    ...reviewDocument
  };

  broadcast("review", publicReview);
  sendJson(res, 201, { review: publicReview });
}

async function deleteReview(req, res, id) {
  if (!ADMIN_KEY) {
    return sendJson(res, 403, { error: "Removing reviews is turned off. Set ADMIN_KEY to enable it." });
  }
  const hash = value => crypto.createHash("sha256").update(String(value)).digest();
  if (!crypto.timingSafeEqual(hash(req.headers["x-admin-key"] || ""), hash(ADMIN_KEY))) {
    return sendJson(res, 401, { error: "Wrong admin key." });
  }

  try {
    const result = await reviewsCollection.deleteOne({ _id: new ObjectId(id) });
    if (result.deletedCount === 0) {
      return sendJson(res, 404, { error: "Review not found." });
    }
    broadcast("remove", { id });
    sendJson(res, 200, { removed: id });
  } catch (error) {
    sendJson(res, 400, { error: "Invalid review ID format." });
  }
}

function serveStatic(pathname, req, res) {
  const file = STATIC_FILES[pathname];
  const notFound = () => {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  };
  if (!file) return notFound();

  fs.readFile(path.join(__dirname, file), (error, content) => {
    if (error) return notFound();
    res.writeHead(200, {
      "Content-Type": CONTENT_TYPES[path.extname(file)],
      "Content-Length": content.length,
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff"
    });
    res.end(req.method === "HEAD" ? undefined : content);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, "http://localhost");

    if (pathname === "/api/reviews" && req.method === "GET") return await getReviews(req, res);
    if (pathname === "/api/reviews" && req.method === "POST") return await createReview(req, res);
    if (pathname === "/api/events" && req.method === "GET") return openStream(req, res);

    const removal = pathname.match(/^\/api\/reviews\/([\w-]{1,64})$/);
    if (removal && req.method === "DELETE") return await deleteReview(req, res, removal[1]);

    if (pathname.startsWith("/api/")) return sendJson(res, 404, { error: "Not found." });
    if (req.method === "GET" || req.method === "HEAD") return serveStatic(pathname, req, res);

    sendJson(res, 405, { error: "Method not allowed." });
  } catch (error) {
    if (res.headersSent) return res.end();
    const status = error.status || 500;
if (status === 500) console.error(error);
sendJson(res, status, { error: status === 500 ? "Something went wrong on the server." : error.message });
}
});
async function main() {
await connectDatabase();
server.listen(PORT, HOST, () => {
console.log("\nForkScore is running (with MongoDB).");
console.log("  On this computer:   http://localhost:" + PORT);
for (const addresses of Object.values(os.networkInterfaces())) {
for (const address of addresses || []) {
if (address.family === "IPv4" && !address.internal) {
console.log("  On your Wi-Fi:      http://" + address.address + ":" + PORT);
}
}
}
if (!ADMIN_KEY) console.log("  Tip: set ADMIN_KEY to be able to remove reviews.");
console.log("");
});
}
function shutdown() {
for (const stream of streams) stream.end();
server.close(async () => {
if (dbClient) await dbClient.close();
process.exit(0);
});
setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
main();