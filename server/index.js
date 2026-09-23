import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import Razorpay from "razorpay";
import multer from "multer";
import { imageKitConfigured, uploadBufferToImageKit, listImageKitFiles, deleteImageKitFile, getImageKitUsage } from "./imagekit-storage.js";
import path from "path";
import fs from "fs";
import { MongoClient, ObjectId } from "mongodb";
import { registerSupplierStockReport } from "./supplier-stock-report.js";

dotenv.config();

const app = express();
// const PORT = Number(process.env.PORT || 4000);
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Aniverse full stack running on port ${PORT}`);
});
let client;
let db;

function getMongoUri() {
  // Support both variable names so existing deployments do not break.
  // Also tolerate values copied into .env with surrounding quotes.
  const raw = process.env.MONGODB_URI ?? process.env.MONGO_URI ?? "";
  const uri = String(raw).trim().replace(/^([\'"])(.*)\1$/, "$2");
  if (!uri) throw new Error("MongoDB connection string is missing. Set MONGODB_URI in .env to a value beginning with mongodb:// or mongodb+srv://.");
  if (!/^mongodb(?:\+srv)?:\/\//i.test(uri)) {
    throw new Error(`Invalid MongoDB connection string. MONGODB_URI must begin with mongodb:// or mongodb+srv:// (received: ${uri.slice(0, 24)}${uri.length > 24 ? "…" : ""})`);
  }
  return uri;
}

const ANIME_WORLD_SLUGS = new Set([
  "attack-on-titan", "bleach", "blue-lock", "chainsaw-man", "dandadan", "death-note",
  "demon-slayer", "dragon-ball", "harry-potter", "hunter-x-hunter", "jujutsu-kaisen",
  "k-pop-demon-hunters", "kaiju-no-8", "marvel", "my-hero-academia", "naruto",
  "one-piece", "onepiece", "solo-leveling", "anime"
]);
function defaultShowInDirectory(category = {}) {
  if (category.showInDirectory !== undefined) return category.showInDirectory === true;
  const value = String(category.slug || slugify(category.name || ""));
  return category.heroEnabled !== true && !ANIME_WORLD_SLUGS.has(value);
}
function normalizeCategoryForStorefront(category) {
  return { ...category, showInDirectory: defaultShowInDirectory(category) };
}

const collections = {
  products: process.env.PRODUCTS_COLLECTION || "products",
  users: process.env.USERS_COLLECTION || "users",
  orders: process.env.ORDERS_COLLECTION || "orders",
  categories: process.env.CATEGORIES_COLLECTION || "categories"
};

const uploadDir = path.join(process.cwd(), "public", "uploads");
fs.mkdirSync(uploadDir, { recursive: true });
const allowedImageTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "image/avif"]);
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024, files: 12 },
  fileFilter: (_req, file, cb) => cb(null, allowedImageTypes.has(file.mimetype))
});

const razorpay = process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET
  ? new Razorpay({ key_id: process.env.RAZORPAY_KEY_ID, key_secret: process.env.RAZORPAY_KEY_SECRET })
  : null;

let shiprocketToken = null;
let shiprocketTokenExpiresAt = 0;
const SHIPROCKET_BASE = "https://apiv2.shiprocket.in/v1/external";
function shiprocketConfigured() { return Boolean(process.env.SHIPROCKET_EMAIL && process.env.SHIPROCKET_PASSWORD); }
async function shiprocketAuth() {
  if (!shiprocketConfigured()) throw new Error("Shiprocket is not configured. Add SHIPROCKET_EMAIL and SHIPROCKET_PASSWORD to .env.");
  if (shiprocketToken && Date.now() < shiprocketTokenExpiresAt) return shiprocketToken;
  const r = await fetch(`${SHIPROCKET_BASE}/auth/login`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify({ email: process.env.SHIPROCKET_EMAIL, password: process.env.SHIPROCKET_PASSWORD }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || !d.token) throw new Error(d.message || d.error || "Shiprocket authentication failed");
  shiprocketToken = d.token; shiprocketTokenExpiresAt = Date.now() + 9 * 24 * 60 * 60 * 1000;
  return shiprocketToken;
}
async function shiprocketRequest(pathname, options = {}) {
  const token = await shiprocketAuth();
  const r = await fetch(`${SHIPROCKET_BASE}${pathname}`, { ...options, headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...(options.headers || {}) } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.message || d.error || `Shiprocket request failed (${r.status})`);
  return d;
}
function orderShippingAddress(order) {
  const a = order?.customer?.address || order?.shippingAddress || order?.address || {};
  return { address: String(a.address || a.line1 || a.address1 || a.street || ""), city: String(a.city || ""), state: String(a.state || a.stateName || ""), pincode: String(a.pincode || a.postalCode || a.zip || ""), country: String(a.country || "India") };
}
function splitName(value) { const parts = String(value || "Customer").trim().split(/\s+/); return { first: parts.shift() || "Customer", last: parts.join(" ") || "" }; }

const jsonLimit = process.env.JSON_LIMIT || "2mb";
const reservationMinutes = Number(process.env.ORDER_RESERVATION_MINUTES || 15);

function oid(value) { try { return new ObjectId(String(value)); } catch { return null; } }
function clean(doc) {
  if (!doc) return doc;
  if (Array.isArray(doc)) return doc.map(clean);
  return { ...doc, _id: doc._id?.toString?.() ?? doc._id };
}
function moneyNumber(value) { const n = Number(value); return Number.isFinite(n) ? n : 0; }
function nonNegativeNumber(value, fallback = 0) { const n = Number(value); return Number.isFinite(n) && n >= 0 ? n : fallback; }
function slugify(value) { return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, ""); }
function stockField(product) {
  if (Object.prototype.hasOwnProperty.call(product, "stock")) return "stock";
  if (Object.prototype.hasOwnProperty.call(product, "inventory")) return "inventory";
  if (Object.prototype.hasOwnProperty.call(product, "quantity")) return "quantity";
  return "inventoryQuantity";
}
function productName(p) { return String(p?.name || p?.title || "Untitled Product"); }
function productImages(p) {
  const raw = Array.isArray(p?.images) ? p.images : Array.isArray(p?.imageUrls) ? p.imageUrls : [];
  return [...new Set([p?.image, p?.imageUrl, p?.thumbnail, ...raw].filter(Boolean).map(String))];
}
function productCategories(p) {
  const raw = [
    ...(Array.isArray(p?.categories) ? p.categories : []),
    p?.category,
    p?.anime,
    ...(Array.isArray(p?.tags) ? p.tags : [])
  ];
  return [...new Set(raw.flatMap(v => Array.isArray(v) ? v : [v]).map(v => typeof v === "object" ? (v.name || v.title || v.slug || v.value || "") : String(v || "")).map(v => v.trim()).filter(Boolean))];
}
function publicProduct(p) {
  const images = productImages(p);
  const stock = moneyNumber(p?.stock ?? p?.inventory ?? p?.quantity ?? p?.inventoryQuantity);
  return clean({
    ...p,
    name: productName(p),
    price: moneyNumber(p?.price ?? p?.salePrice ?? p?.sellingPrice),
    old: moneyNumber(p?.old ?? p?.compareAtPrice ?? p?.mrp ?? p?.originalPrice) || null,
    img: images[0] || "",
    images,
    stock,
    categories: productCategories(p),
    isPreorder: Boolean(p?.isPreorder ?? p?.preorder ?? p?.preOrder ?? p?.isPreOrder),
    badge: p?.badge || (Boolean(p?.isPreorder ?? p?.preorder ?? p?.preOrder ?? p?.isPreOrder) ? "PRE-ORDER" : "COLLECTIBLE")
  });
}
async function col(name) { if (!db) throw new Error("Database not connected"); return db.collection(collections[name]); }
function safeEqualHex(a, b) {
  if (!a || !b || String(a).length !== String(b).length) return false;
  return crypto.timingSafeEqual(Buffer.from(String(a)), Buffer.from(String(b)));
}
function requireEnv(name) { if (!process.env[name]) throw new Error(`${name} is required`); }
function auth(req, res, next) {
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return res.status(401).json({ error: "Authentication required" });
  try { req.admin = jwt.verify(token, process.env.JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: "Invalid or expired token" }); }
}
const ADMIN_PERMISSIONS = new Set([
  "orders", "products", "inventory", "collections", "animeHero", "customers",
  "analytics", "discounts", "shipping", "settings", "staff", "files", "drafts", "supplier-stock-report"
]);
function permissionForRequest(req) {
  const path = String(req.path || "");
  if (path.startsWith("/api/admin/staff")) return "staff";
  if (path.startsWith("/api/admin/files") || path.startsWith("/api/admin/uploads") || path.startsWith("/api/admin/imagekit")) return "files";
  if (path.startsWith("/api/admin/settings") || path.startsWith("/api/admin/activity")) return "settings";
  if (path.startsWith("/api/admin/export")) {
    const type = String(req.params?.type || "");
    return type === "products" ? "products" : type === "customers" ? "customers" : type === "orders" ? "orders" : "settings";
  }
  if (path.startsWith("/api/draft-orders")) return "drafts";
  if (path.includes("/refund")) return "orders.refund";
  if (path.includes("/shipping/")) return "shipping";
  if (path.startsWith("/api/orders")) return req.method === "GET" ? "orders" : "orders.edit";
  if (path.includes("/inventory")) return "inventory";
  if (path.startsWith("/api/products")) return req.method === "GET" ? "products" : "products.edit";
  if (path.startsWith("/api/users")) return req.method === "GET" ? "customers" : "customers.edit";
  if (path.startsWith("/api/categories")) return "collections";
  if (path.startsWith("/api/hero")) return "animeHero";
  if (path.startsWith("/api/admin/discounts") || path.startsWith("/api/discounts")) return "discounts";
  if (path.includes("supplier-stock-report") || path.includes("supplier")) return "supplier-stock-report";
  if (path.startsWith("/api/admin/analytics") || path.startsWith("/api/admin/dashboard")) return "analytics";
  if (path.startsWith("/api/dashboard")) return null;
  if (path.startsWith("/api/admin/inventory")) return "inventory";
  if (path.startsWith("/api/admin/products")) return "products";
  if (path.startsWith("/api/admin/shipping")) return "shipping";
  if (path.startsWith("/api/admin/discounts") || path.startsWith("/api/discounts")) return "discounts";
  return null;
}
function hasPermission(req, permission) {
  if (req.admin?.role === "admin") return true;
  const permissions = new Set(Array.isArray(req.admin?.permissions) ? req.admin.permissions : []);
  if (permissions.has(permission)) return true;
  const base = String(permission).split(".")[0];
  return permissions.has(base);
}
async function adminOnly(req, res, next) {
  if (!["admin", "staff"].includes(req.admin?.role)) return res.status(403).json({ error: "Admin access required" });
  try {
    if (req.admin?.source !== "env" && req.admin?.id) {
      const user = await (await col("users")).findOne({ _id: oid(req.admin.id), role: { $in: ["admin", "staff"] } }, { projection: { status: 1, role: 1, permissions: 1, email: 1 } });
      if (!user) return res.status(401).json({ error: "Admin account no longer exists" });
      if (user.status === "inactive" || user.status === "blocked") return res.status(403).json({ error: "This admin account is inactive" });
      req.admin.role = user.role;
      req.admin.status = user.status || "active";
      req.admin.permissions = user.role === "admin" ? [...ADMIN_PERMISSIONS] : (Array.isArray(user.permissions) ? user.permissions : []);
      req.admin.email = user.email || req.admin.email;
    }
    const permission = permissionForRequest(req);
    if (permission === "staff" && req.admin.role !== "admin") return res.status(403).json({ error: "Only an administrator can manage staff accounts" });
    if (permission && !hasPermission(req, permission)) return res.status(403).json({ error: `Permission required: ${permission}` });
    next();
  } catch (error) {
    console.error("Admin authorization error:", error);
    return res.status(500).json({ error: "Could not verify admin permissions" });
  }
}
function customerAuth(req, res, next) {
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return res.status(401).json({ error: "Customer authentication required" });
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.role !== "customer") return res.status(403).json({ error: "Customer account required" });
    req.customer = payload;
    next();
  } catch { return res.status(401).json({ error: "Invalid or expired customer session" }); }
}
function optionalCustomerAuth(req, _res, next) {
  const token = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return next();
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    if (payload.role === "customer") req.customer = payload;
  } catch {}
  next();
}


// Razorpay webhook: keep raw body before express.json().
app.post("/api/payments/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  try {
    if (!process.env.RAZORPAY_WEBHOOK_SECRET) return res.status(503).json({ error: "Webhook secret not configured" });
    const signature = req.headers["x-razorpay-signature"];
    const expected = crypto.createHmac("sha256", process.env.RAZORPAY_WEBHOOK_SECRET).update(req.body).digest("hex");
    if (!safeEqualHex(expected, signature)) return res.status(400).json({ error: "Invalid webhook signature" });
    const event = JSON.parse(req.body.toString("utf8"));
    const payment = event.payload?.payment?.entity;
    const orderEntity = event.payload?.order?.entity;
    const razorpayOrderId = payment?.order_id || orderEntity?.id;
    if (!razorpayOrderId) return res.json({ ok: true, ignored: true });

    if (["payment.captured", "order.paid"].includes(event.event)) {
      const paymentId = payment?.id || null;
      await finalizePaidOrder({ razorpayOrderId, paymentId, signature: null, event: event.event });
    } else if (event.event === "payment.authorized") {
      await (await col("orders")).updateOne({ razorpayOrderId, paymentStatus: { $ne: "paid" } }, { $set: { paymentStatus: "authorized", razorpayPaymentId: payment?.id || null, razorpayEvent: event.event, updatedAt: new Date() } });
    } else if (event.event === "payment.failed") {
      await releaseReservation(razorpayOrderId, "payment_failed");
    }
    res.json({ ok: true });
  } catch (error) {
    console.error("Webhook error:", error);
    res.status(500).json({ error: "Webhook processing failed" });
  }
});

app.use(express.json({ limit: jsonLimit }));
// Supplier Stock Report routes are registered after express.json().
const supplierStockReport = registerSupplierStockReport({ app, getDb: () => db, reconnect: async () => { try { await client.close(); } catch {} await client.connect(); db = client.db(process.env.MONGODB_DB || undefined); return db; }, collections, auth, adminOnly });
const configuredCors = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(",").map(x => x.trim()).filter(Boolean)
  : [];
const corsOrigin = (origin, callback) => {
  if (!origin || configuredCors.length === 0) return callback(null, true);
  if (configuredCors.includes(origin)) return callback(null, true);
  try {
    const url = new URL(origin);
    if ((url.hostname === "localhost" || url.hostname === "127.0.0.1") && ["3000", "4000", "5000", "5173", "4173"].includes(url.port)) {
      return callback(null, true);
    }
  } catch {}
  return callback(new Error("CORS origin not allowed"));
};
app.use(cors({ origin: corsOrigin, credentials: true }));
app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
});

app.get("/api/health", async (_req, res) => {
  let database = false;
  try { if (db) { await db.command({ ping: 1 }); database = true; } } catch {}
  res.status(database ? 200 : 503).json({ ok: database, db: database, razorpay: Boolean(razorpay), environment: process.env.NODE_ENV || "development" });
});

const loginAttempts = new Map();
function loginRateLimit(req, res, next) {
  const key = `${req.ip}:${String(req.body?.email || "").toLowerCase()}`; const now = Date.now(); const recent = loginAttempts.get(key) || []; const kept = recent.filter(t => now - t < 10 * 60 * 1000);
  if (kept.length >= 10) return res.status(429).json({ error: "Too many login attempts. Please try again later." });
  kept.push(now); loginAttempts.set(key, kept); next();
}

app.post("/api/account/register", loginRateLimit, async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    const email = String(req.body?.email || "").trim().toLowerCase();
    const phone = String(req.body?.phone || "").replace(/\D/g, "");
    const password = String(req.body?.password || "");
    if (name.length < 2 || !/^\S+@\S+\.\S+$/.test(email) || password.length < 8) return res.status(400).json({ error: "Name, valid email and password (8+ characters) are required" });
    if (phone && phone.length < 10) return res.status(400).json({ error: "Please enter a valid phone number" });
    const users = await col("users");
    const existing = await users.findOne({ email });
    if (existing) return res.status(409).json({ error: "An account with this email already exists. Please sign in." });
    const doc = { name, email, phone, role: "customer", status: "active", addresses: [], wishlist: [], passwordHash: await bcrypt.hash(password, 12), createdAt: new Date(), updatedAt: new Date() };
    const result = await users.insertOne(doc);
    const token = jwt.sign({ id: String(result.insertedId), email, role: "customer" }, process.env.JWT_SECRET, { expiresIn: "30d" });
    res.status(201).json({ token, user: { id: String(result.insertedId), name, email, phone, role: "customer" } });
  } catch (error) { console.error("Customer register error:", error); res.status(500).json({ error: "Could not create account" }); }
});

app.post("/api/account/login", loginRateLimit, async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    if (!email || !password) return res.status(400).json({ error: "Email and password are required" });
    const user = await (await col("users")).findOne({ email, role: "customer" });
    if (!user || !(await bcrypt.compare(password, user.passwordHash || user.password || user.hash || ""))) return res.status(401).json({ error: "Invalid email or password" });
    if (user.status === "blocked") return res.status(403).json({ error: "This account is currently blocked. Please contact Aniverse." });
    const token = jwt.sign({ id: String(user._id), email: user.email, role: "customer" }, process.env.JWT_SECRET, { expiresIn: "30d" });
    res.json({ token, user: { id: String(user._id), name: user.name || "", email: user.email, phone: user.phone || "", role: "customer" } });
  } catch (error) { console.error("Customer login error:", error); res.status(500).json({ error: "Login failed" }); }
});

app.get("/api/account/me", customerAuth, async (req, res) => {
  const user = await (await col("users")).findOne({ _id: oid(req.customer.id), role: "customer" }, { projection: { password: 0, passwordHash: 0, hash: 0 } });
  if (!user) return res.status(404).json({ error: "Customer account not found" });
  res.json(clean({ id: user._id, name: user.name || "", email: user.email || "", phone: user.phone || "", addresses: user.addresses || [] }));
});

app.patch("/api/account/me", customerAuth, async (req, res) => {
  try {
    const id = oid(req.customer.id); if (!id) return res.status(400).json({ error: "Invalid customer account" });
    const allowed = {};
    if (req.body?.name !== undefined) { const name = String(req.body.name).trim(); if (name.length < 2) return res.status(400).json({ error: "Name is required" }); allowed.name = name; }
    if (req.body?.phone !== undefined) { const phone = String(req.body.phone).replace(/\D/g, ""); if (phone && phone.length < 10) return res.status(400).json({ error: "Please enter a valid phone number" }); allowed.phone = phone; }
    if (Array.isArray(req.body?.addresses)) allowed.addresses = req.body.addresses.slice(0, 10).map(a => ({ label: String(a?.label || "Address").slice(0, 40), line1: String(a?.line1 || "").slice(0, 300), city: String(a?.city || "").slice(0, 80), state: String(a?.state || "").slice(0, 80), pincode: String(a?.pincode || "").replace(/\D/g, "").slice(0, 10), country: String(a?.country || "India").slice(0, 40) }));
    allowed.updatedAt = new Date();
    await (await col("users")).updateOne({ _id: id, role: "customer" }, { $set: allowed });
    const user = await (await col("users")).findOne({ _id: id }, { projection: { password: 0, passwordHash: 0, hash: 0 } });
    res.json(clean({ id: user._id, name: user.name || "", email: user.email || "", phone: user.phone || "", addresses: user.addresses || [] }));
  } catch (error) { res.status(500).json({ error: error.message || "Could not update account" }); }
});

app.get("/api/account/orders", customerAuth, async (req, res) => {
  const id = oid(req.customer.id); if (!id) return res.status(400).json({ error: "Invalid customer account" });
  const user = await (await col("users")).findOne({ _id: id }, { projection: { email: 1 } });
  const filter = { $or: [{ customerId: id }, { "customer.email": String(user?.email || req.customer.email).toLowerCase() }] };
  const orders = await (await col("orders")).find(filter, { projection: { items: 1, customer: 1, orderNumber: 1, total: 1, subtotal: 1, shipping: 1, discount: 1, currency: 1, status: 1, paymentStatus: 1, createdAt: 1, paidAt: 1, shipment: 1 } }).sort({ createdAt: -1 }).limit(100).toArray();
  res.json(clean(orders));
});

app.post("/api/auth/login", loginRateLimit, async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    if (!email || !password) return res.status(400).json({ error: "Email and password are required" });
    if (email === String(process.env.ADMIN_EMAIL || "").trim().toLowerCase() && password === String(process.env.ADMIN_PASSWORD || "")) {
      return res.json({ token: jwt.sign({ email, role: "admin", status: "active", permissions: [...ADMIN_PERMISSIONS], source: "env" }, process.env.JWT_SECRET, { expiresIn: "12h" }), user: { email, role: "admin", status: "active", permissions: [...ADMIN_PERMISSIONS] } });
    }
    const user = await (await col("users")).findOne({ email });
    if (!user) return res.status(401).json({ error: "Invalid credentials" });
    const hash = user.passwordHash || user.password || user.hash;
    if (!hash || !(await bcrypt.compare(password, hash))) return res.status(401).json({ error: "Invalid credentials" });
    const role = user.role || user.accountType || "customer";
    if (!["admin", "staff"].includes(role)) return res.status(403).json({ error: "Admin access required" });
    if (user.status === "inactive" || user.status === "blocked") return res.status(403).json({ error: "This admin account is inactive. Contact an administrator." });
    const permissions = role === "admin" ? [...ADMIN_PERMISSIONS] : (Array.isArray(user.permissions) ? user.permissions : []);
    res.json({ token: jwt.sign({ id: String(user._id), email: user.email, role, status: user.status || "active", permissions }, process.env.JWT_SECRET, { expiresIn: "12h" }), user: { id: String(user._id), email: user.email, role, status: user.status || "active", permissions } });
  } catch (error) { console.error(error); res.status(500).json({ error: "Login failed" }); }
});

app.get("/api/products", async (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const category = String(req.query.category || "").trim();
    const filter = { active: { $ne: false } };
    if (q) {
      const rx = { $regex: q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), $options: "i" };
      filter.$or = [{ name: rx }, { title: rx }, { category: rx }, { anime: rx }, { categories: rx }, { tags: rx }];
    }
    if (category) {
      const rx = { $regex: `^${category.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" };
      filter.$and = [{ $or: [{ category: rx }, { anime: rx }, { categories: rx }] }];
    }
    const limit = Math.min(Math.max(Number(req.query.limit || 200), 1), 2000);
    const docs = await (await col("products")).find(filter).sort({ featured: -1, createdAt: -1 }).limit(limit).toArray();
    res.json(docs.map(publicProduct));
  } catch (error) { console.error(error); res.status(500).json({ error: "Could not load products" }); }
});

app.get("/api/products/:id", async (req, res) => {
  try {
    const id = oid(req.params.id); if (!id) return res.status(400).json({ error: "Invalid product id" });
    const p = await (await col("products")).findOne({ _id: id, active: { $ne: false } });
    if (!p) return res.status(404).json({ error: "Product not found" });
    res.json(publicProduct(p));
  } catch (error) { console.error(error); res.status(500).json({ error: "Could not load product" }); }
});

app.get("/api/store/settings", async (_req,res)=>{try{const docs=await (await adminCol("settings")).find({key:{$in:["shippingFreeThreshold","standardShipping","announcement","storeName","supportEmail","supportPhone"]}}).toArray();const values=Object.fromEntries(docs.map(x=>[x.key,x.value]));res.json({shippingFreeThreshold:nonNegativeNumber(values.shippingFreeThreshold,999),standardShipping:nonNegativeNumber(values.standardShipping,79),announcement:values.announcement||"FREE SHIPPING ON ORDERS ABOVE ₹999 • SHOP ANIVERSE",storeName:values.storeName||"Aniverse",supportEmail:values.supportEmail||"",supportPhone:values.supportPhone||""});}catch(e){res.status(500).json({error:"Could not load store settings"});}});
app.get("/api/categories", async (_req, res) => {
  try {
    const docs = await (await col("categories")).find({}).sort({ name: 1 }).toArray();
    res.json(clean(docs.map(normalizeCategoryForStorefront)));
  } catch (error) { console.error(error); res.status(500).json({ error: "Could not load categories" }); }
});

app.get("/api/hero", async (_req, res) => {
  try {
    const categories = await col("categories");
    const hero = await categories.find({ heroEnabled: true }).sort({ heroOrder: 1, name: 1 }).toArray();
    res.json(clean(hero));
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Could not load anime hero" });
  }
});

async function normalizeCartItems(items) {
  const merged = new Map();
  for (const item of items) {
    const id = oid(item.productId || item.id); if (!id) throw new Error("Invalid product id");
    const qty = Math.max(1, Math.min(99, Math.floor(Number(item.qty) || 1)));
    const key = id.toString(); merged.set(key, (merged.get(key) || 0) + qty);
  }
  return [...merged.entries()].map(([productId, qty]) => ({ productId, qty: Math.min(qty, 99) }));
}

async function quoteCart(items) {
  const products = await col("products");
  const normalized = [];
  for (const item of await normalizeCartItems(items)) {
    const id = oid(item.productId); const p = await products.findOne({ _id: id });
    if (!p || p.active === false) throw new Error("A product in your cart is unavailable");
    const field = stockField(p); const available = moneyNumber(p[field]);
    if (available < item.qty) throw new Error(`Insufficient stock for ${productName(p)}`);
    normalized.push({ productId: item.productId, name: productName(p), price: moneyNumber(p.price ?? p.salePrice ?? p.sellingPrice), qty: item.qty, image: productImages(p)[0] || "" });
  }
  const subtotal = normalized.reduce((sum, x) => sum + x.price * x.qty, 0);
  const settingsDocs = await (await adminCol("settings")).find({ key: { $in: ["shippingFreeThreshold","standardShipping"] } }).toArray();
  const settings = Object.fromEntries(settingsDocs.map(x=>[x.key,x.value]));
  const freeThreshold = nonNegativeNumber(settings.shippingFreeThreshold, 999);
  const standardShipping = nonNegativeNumber(settings.standardShipping, 79);
  const shipping = subtotal >= freeThreshold ? 0 : standardShipping;
  return { normalized, subtotal, shipping, total: subtotal + shipping };
}

async function reserveQuotedStock(normalized, session) {
  const products = await col("products");
  for (const item of normalized) {
    const id = oid(item.productId); const p = await products.findOne({ _id: id }, { session });
    if (!p || p.active === false) throw new Error("A product in your cart is unavailable");
    const field = stockField(p);
    const changed = await products.updateOne({ _id: id, [field]: { $gte: item.qty } }, { $inc: { [field]: -item.qty }, $set: { updatedAt: new Date() } }, { session });
    if (changed.modifiedCount !== 1) throw new Error(`Stock changed for ${productName(p)}. Please retry checkout.`);
  }
}


async function resolveDiscount(code, subtotal) {
  const normalized=String(code||"").trim().toUpperCase(); if(!normalized) return {code:"",amount:0};
  const d=await (await adminCol("discounts")).findOne({code:normalized,active:true}); if(!d) throw new Error("Invalid or inactive discount code");
  const now=new Date(); if(d.startsAt&&new Date(d.startsAt)>now || d.endsAt&&new Date(d.endsAt)<now) throw new Error("This discount is outside its valid dates");
  if(d.usageLimit&&Number(d.usedCount||0)>=Number(d.usageLimit)) throw new Error("This discount has reached its usage limit");
  if(subtotal<Number(d.minimumAmount||0)) throw new Error(`Minimum order value is ₹${Number(d.minimumAmount).toLocaleString("en-IN")}`);
  const amount=d.type==="fixed"?Math.min(subtotal,Number(d.value)||0):Math.min(subtotal,subtotal*Math.min(100,Number(d.value)||0)/100);
  return {code:normalized,amount,discountId:d._id};
}

app.post("/api/checkout/create-order", optionalCustomerAuth, async (req, res) => {
  try {
    if (!razorpay) return res.status(503).json({ error: "Razorpay is not configured" });
    const { items, customer } = req.body || {};
    const address = customer?.address && typeof customer.address === "object"
      ? { line1: String(customer.address.line1 || customer.address.address || "").trim(), city: String(customer.address.city || "").trim(), state: String(customer.address.state || "").trim(), pincode: String(customer.address.pincode || "").trim() }
      : {};
    const name = String(customer?.name || "").trim();
    const email = String(customer?.email || "").trim().toLowerCase();
    const phone = String(customer?.phone || "").replace(/\D/g, "");
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: "Cart is empty" });
    if (name.length < 2 || !/^\S+@\S+\.\S+$/.test(email) || phone.length < 10) return res.status(400).json({ error: "Please provide a valid name, email and phone number" });

    const quote = await quoteCart(items);
    const discount = await resolveDiscount(req.body?.discountCode, quote.subtotal);
    const discountedSubtotal = Math.max(0, quote.subtotal - discount.amount);
    const settingsDocs = await (await adminCol("settings")).find({ key: { $in: ["shippingFreeThreshold","standardShipping"] } }).toArray();
    const settings = Object.fromEntries(settingsDocs.map(x=>[x.key,x.value]));
    const freeThreshold = nonNegativeNumber(settings.shippingFreeThreshold, 999);
    const standardShipping = nonNegativeNumber(settings.standardShipping, 79);
    const shipping = discountedSubtotal >= freeThreshold ? 0 : (discountedSubtotal ? standardShipping : 0);
    quote.discount = discount.amount; quote.discountCode = discount.code; quote.subtotalAfterDiscount = discountedSubtotal; quote.shipping = shipping; quote.total = discountedSubtotal + shipping;
    const receipt = `ANV-${Date.now()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
    const rpOrder = await razorpay.orders.create({ amount: Math.round(quote.total * 100), currency: "INR", receipt, notes: { brand: "Aniverse", email, discountCode: discount.code || "" } });
    const session = client.startSession(); let orderId;
    try {
      await session.withTransaction(async () => {
        await reserveQuotedStock(quote.normalized, session);
        const doc = { orderNumber: receipt, customerId: req.customer?.id ? oid(req.customer.id) : null, items: quote.normalized, customer: { name, email, phone, address }, subtotal: quote.subtotal, discount: quote.discount || 0, discountCode: quote.discountCode || "", subtotalAfterDiscount: quote.subtotalAfterDiscount ?? quote.subtotal, shipping: quote.shipping, total: quote.total, currency: "INR", status: "pending", paymentStatus: "created", inventoryReserved: true, reservedUntil: new Date(Date.now() + reservationMinutes * 60 * 1000), razorpayOrderId: rpOrder.id, createdAt: new Date(), updatedAt: new Date() };
        const result = await (await col("orders")).insertOne(doc, { session }); orderId = result.insertedId.toString();
      });
    } finally { await session.endSession(); }
    res.status(201).json({ orderId, orderNumber: receipt, razorpayOrderId: rpOrder.id, amount: rpOrder.amount, currency: rpOrder.currency, keyId: process.env.RAZORPAY_KEY_ID, total: quote.total });
  } catch (error) {
    console.error("Create order error:", error);
    res.status(error.message?.startsWith("Insufficient") || error.message?.includes("Stock changed") ? 409 : 500).json({ error: error.message || "Could not create payment order" });
  }
});

async function releaseReservation(razorpayOrderId, reason = "expired") {
  const orders = await col("orders");
  const session = client.startSession();
  try {
    await session.withTransaction(async () => {
      const order = await orders.findOne({ razorpayOrderId }, { session });
      if (!order || !order.inventoryReserved || order.paymentStatus === "paid") return;
      const products = await col("products");
      for (const item of order.items || []) {
        const id = oid(item.productId); if (!id) continue;
        const p = await products.findOne({ _id: id }, { session }); if (!p) continue;
        const field = stockField(p);
        await products.updateOne({ _id: id }, { $inc: { [field]: Number(item.qty) || 0 }, $set: { updatedAt: new Date() } }, { session });
      }
      await orders.updateOne({ _id: order._id, inventoryReserved: true }, { $set: { inventoryReserved: false, paymentStatus: order.paymentStatus === "created" ? "failed" : order.paymentStatus, status: reason === "cancelled" ? "cancelled" : "expired", reservationReleasedAt: new Date(), releaseReason: reason, updatedAt: new Date() } }, { session });
    });
  } finally { await session.endSession(); }
}

async function finalizePaidOrder({ razorpayOrderId, paymentId, signature, event = "payment.captured" }) {
  const orders = await col("orders");
  const session = client.startSession();
  try {
    await session.withTransaction(async () => {
      const current = await orders.findOne({ razorpayOrderId }, { session });
      if (!current) throw new Error("Order not found");
      if (current.paymentStatus === "paid") return;
      await orders.updateOne({ _id: current._id }, { $set: { paymentStatus: "paid", status: "confirmed", inventoryReserved: false, razorpayPaymentId: paymentId || current.razorpayPaymentId || null, razorpaySignature: signature || current.razorpaySignature || null, razorpayEvent: event, paidAt: current.paidAt || new Date(), updatedAt: new Date() } }, { session });
      if (current.discountCode) await (await adminCol("discounts")).updateOne({ code: current.discountCode }, { $inc: { usedCount: 1 }, $set: { updatedAt: new Date() } }, { session });
    });
  } finally { await session.endSession(); }
  return orders.findOne({ razorpayOrderId });
}

app.post("/api/checkout/verify", async (req, res) => {
  try {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body || {};
    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) return res.status(400).json({ error: "Incomplete payment response" });
    const order = await (await col("orders")).findOne({ razorpayOrderId: razorpay_order_id });
    if (!order) return res.status(404).json({ error: "Aniverse order not found" });
    const expected = crypto.createHmac("sha256", process.env.RAZORPAY_KEY_SECRET).update(`${order.razorpayOrderId}|${razorpay_payment_id}`).digest("hex");
    if (!safeEqualHex(expected, razorpay_signature)) return res.status(400).json({ error: "Payment signature verification failed" });
    const paid = await finalizePaidOrder({ razorpayOrderId: razorpay_order_id, paymentId: razorpay_payment_id, signature: razorpay_signature, event: "client_verification" });
    res.json({ ok: true, order: clean(paid) });
  } catch (error) { console.error(error); res.status(500).json({ error: error.message || "Payment verification failed" }); }
});

// Admin uploads are stored in ImageKit Media Library.
app.post("/api/admin/uploads", auth, adminOnly, upload.array("images", 12), async (req, res) => {
  try {
    if (!imageKitConfigured()) return res.status(503).json({ error: "ImageKit is not configured. Add IMAGEKIT_PRIVATE_KEY to .env." });
    const files = Array.isArray(req.files) ? req.files : [];
    const uploaded = [];
    for (const file of files) {
      const result = await uploadBufferToImageKit(file.buffer, file.originalname, { folder: "/aniverse/products" });
      uploaded.push(result);
    }
    res.status(201).json({ images: uploaded.map(x => x.url), files: uploaded });
  } catch (e) {
    console.error("ImageKit upload failed:", e);
    res.status(500).json({ error: e.message || "Image upload failed" });
  }
});
app.delete("/api/admin/uploads", auth, adminOnly, async (req, res) => {
  try {
    if (!imageKitConfigured()) return res.status(503).json({ error: "ImageKit is not configured." });
    const fileIds = Array.isArray(req.body?.fileIds) ? req.body.fileIds : [];
    const images = Array.isArray(req.body?.images) ? req.body.images : [req.body?.image].filter(Boolean);
    let deleted = 0;
    for (const id of fileIds) { await deleteImageKitFile(String(id)); deleted++; }
    if (images.length) {
      const all = await listImageKitFiles({ limit: 1000, path: "/aniverse/" });
      for (const value of images.map(String)) {
        const hit = all.find(f => f.url === value || f.filePath === value || f.name === value);
        if (hit?.fileId) { await deleteImageKitFile(hit.fileId); deleted++; }
      }
    }
    res.json({ ok: true, deleted });
  } catch (e) {
    console.error("ImageKit delete failed:", e);
    res.status(500).json({ error: e.message || "Could not delete image" });
  }
});

app.get("/api/dashboard", auth, adminOnly, async (_req, res) => {
  try {
    const [products, users, orders] = await Promise.all([col("products"), col("users"), col("orders")]);
    const [productCount, userCount, orderCount, lowStock, agg, paidCount] = await Promise.all([
      products.countDocuments(), users.countDocuments(), orders.countDocuments(),
      products.countDocuments({ $or: [{ stock: { $lte: 5 } }, { inventory: { $lte: 5 } }, { quantity: { $lte: 5 } }, { inventoryQuantity: { $lte: 5 } }] }),
      orders.aggregate([{ $match: { paymentStatus: "paid" } }, { $group: { _id: null, total: { $sum: { $ifNull: ["$total", 0] } } } }]).toArray(),
      orders.countDocuments({ paymentStatus: "paid" })
    ]);
    const openOrderCount = await orders.countDocuments({ status: { $nin: ["delivered", "cancelled"] } });
    res.json({ productCount, userCount, orderCount, paidOrderCount: paidCount, openOrderCount, lowStock, revenue: agg[0]?.total || 0 });
  } catch (error) { console.error(error); res.status(500).json({ error: "Could not load dashboard" }); }
});

function normalizeProductPayload(body, existing = {}) {
  const p = { ...body };
  delete p._id;
  p.name = String(p.name || p.title || existing.name || existing.title || "").trim();
  p.price = moneyNumber(p.price);
  if (p.compareAtPrice !== undefined) p.compareAtPrice = moneyNumber(p.compareAtPrice);
  p.stock = Math.max(0, Math.floor(moneyNumber(p.stock ?? existing.stock ?? existing.inventory ?? existing.quantity ?? existing.inventoryQuantity)));
  p.categories = Array.isArray(p.categories) ? [...new Set(p.categories.map(String).map(x => x.trim()).filter(Boolean))] : productCategories(p);
  p.category = p.categories[0] || String(p.category || existing.category || "").trim();
  p.anime = String(p.anime || existing.anime || "").trim();
  p.slug = String(p.slug || existing.slug || slugify(p.name)).trim();
  p.images = Array.isArray(p.images) ? [...new Set(p.images.map(String).filter(Boolean))].slice(0, 12) : productImages(existing);
  p.image = p.images[0] || "";
  p.badge = String(p.badge || existing.badge || "COLLECTIBLE").trim();
  p.description = String(p.description ?? existing.description ?? "").trim();
  p.vendor = String(p.vendor ?? existing.vendor ?? "").trim();
  p.productType = String(p.productType ?? existing.productType ?? "").trim();
  p.hsnCode = String(p.hsnCode ?? existing.hsnCode ?? "").trim();
  p.gstRate = nonNegativeNumber(p.gstRate ?? existing.gstRate, 0);
  p.requiresShipping = p.requiresShipping !== undefined ? Boolean(p.requiresShipping) : existing.requiresShipping !== false;
  p.weight = nonNegativeNumber(p.weight ?? existing.weight, 0);
  p.package = {
    length: nonNegativeNumber(p.package?.length ?? existing.package?.length, 0),
    width: nonNegativeNumber(p.package?.width ?? existing.package?.width, 0),
    height: nonNegativeNumber(p.package?.height ?? existing.package?.height, 0)
  };
  p.seoTitle = String(p.seoTitle ?? existing.seoTitle ?? "").trim();
  p.seoDescription = String(p.seoDescription ?? existing.seoDescription ?? "").trim();
  p.isPreorder = Boolean(p.isPreorder);
  p.featured = Boolean(p.featured);
  p.active = p.active !== false;
  return p;
}

app.get("/api/admin/products", auth, adminOnly, async (req, res) => {
  const q = String(req.query.q || "").trim();
  const filter = q ? { $or: [{ name: { $regex: q, $options: "i" } }, { category: { $regex: q, $options: "i" } }, { categories: { $regex: q, $options: "i" } }] } : {};
  res.json((await (await col("products")).find(filter).sort({ updatedAt: -1, createdAt: -1 }).limit(500).toArray()).map(publicProduct));
});
app.post("/api/products", auth, adminOnly, async (req, res) => {
  try {
    const p = normalizeProductPayload(req.body);
    if (!p.name) return res.status(400).json({ error: "Product name is required" });
    p.createdAt = new Date(); p.updatedAt = new Date();
    const r = await (await col("products")).insertOne(p);
    res.status(201).json(publicProduct({ ...p, _id: r.insertedId }));
  } catch (error) { console.error(error); res.status(500).json({ error: "Could not create product" }); }
});
app.put("/api/products/:id", auth, adminOnly, async (req, res) => {
  try {
    const id = oid(req.params.id); if (!id) return res.status(400).json({ error: "Invalid product id" });
    const products = await col("products"); const existing = await products.findOne({ _id: id });
    if (!existing) return res.status(404).json({ error: "Product not found" });
    const p = normalizeProductPayload(req.body, existing); p.updatedAt = new Date();
    await products.updateOne({ _id: id }, { $set: p });
    res.json(publicProduct(await products.findOne({ _id: id })));
  } catch (error) { console.error(error); res.status(500).json({ error: "Could not update product" }); }
});
app.delete("/api/products/:id", auth, adminOnly, async (req, res) => {
  const id = oid(req.params.id); if (!id) return res.status(400).json({ error: "Invalid product id" });
  const products = await col("products");
  const product = await products.findOne({ _id: id });
  if (!product) return res.status(404).json({ error: "Product not found" });
  await products.deleteOne({ _id: id });
  for (const value of productImages(product)) {
    if (!value.startsWith("/uploads/")) continue;
    const target = path.join(uploadDir, path.basename(value));
    if (target.startsWith(uploadDir) && fs.existsSync(target)) fs.unlinkSync(target);
  }
  res.json({ ok: true });
});
app.patch("/api/products/:id/inventory", auth, adminOnly, async (req, res) => {
  const id = oid(req.params.id); const stock = Number(req.body?.stock);
  if (!id || !Number.isInteger(stock) || stock < 0) return res.status(400).json({ error: "Stock must be a non-negative whole number" });
  const products = await col("products"); const p = await products.findOne({ _id: id }); if (!p) return res.status(404).json({ error: "Product not found" });
  const field = stockField(p); const previous = moneyNumber(p[field]);
  await products.updateOne({ _id: id }, { $set: { [field]: stock, stock, updatedAt: new Date() } });
  await (await adminCol("inventory")).insertOne({ productId:String(id), productName:productName(p), previous, quantity:stock, delta:stock-previous, reason:String(req.body?.reason||"manual_adjustment"), admin:req.admin?.email||"admin", createdAt:new Date() });
  res.json(publicProduct(await products.findOne({ _id: id })));
});

app.get("/api/users", auth, adminOnly, async (req, res) => {
  const q = String(req.query.q || "").trim();
  const filter = q ? { $or: [{ email: { $regex: q, $options: "i" } }, { name: { $regex: q, $options: "i" } }, { phone: { $regex: q, $options: "i" } }] } : {};
  const docs = await (await col("users")).find(filter, { projection: { password: 0, passwordHash: 0, hash: 0 } }).sort({ createdAt: -1 }).limit(500).toArray();
  const emails=docs.map(x=>String(x.email||"").toLowerCase()).filter(Boolean);
  const orderStats=emails.length?await (await col("orders")).aggregate([{ $match:{ paymentStatus:"paid", "customer.email":{$in:emails} } },{ $group:{ _id:{ $toLower:"$customer.email" }, orders:{$sum:1}, spent:{$sum:{$ifNull:["$total",0]}} } }]).toArray():[];
  const statMap=new Map(orderStats.map(x=>[x._id,x]));
  res.json(docs.map(x=>clean({...x,ordersCount:statMap.get(String(x.email||"").toLowerCase())?.orders||0,totalSpent:statMap.get(String(x.email||"").toLowerCase())?.spent||0})));
});
app.patch("/api/users/:id", auth, adminOnly, async (req, res) => {
  const id = oid(req.params.id); if (!id) return res.status(400).json({ error: "Invalid user id" });
  const allowed = {};
  for (const key of ["name", "email", "role", "status", "phone", "address", "city", "state", "pincode", "postalCode", "country"]) if (req.body?.[key] !== undefined) allowed[key] = req.body[key];
  if (allowed.email !== undefined) {
    allowed.email = String(allowed.email).trim().toLowerCase();
    if (!allowed.email) return res.status(400).json({ error: "Email cannot be empty" });
    const conflict = await (await col("users")).findOne({ email: allowed.email, _id: { $ne: id } });
    if (conflict) return res.status(409).json({ error: "Another customer already uses this email" });
  }
  allowed.updatedAt = new Date();
  await (await col("users")).updateOne({ _id: id }, { $set: allowed });
  res.json(clean(await (await col("users")).findOne({ _id: id }, { projection: { password: 0, passwordHash: 0, hash: 0 } })));
});

app.get("/api/orders", auth, adminOnly, async (_req, res) => res.json(clean(await (await col("orders")).find({}).sort({ createdAt: -1 }).limit(500).toArray())));
app.patch("/api/orders/:id/customer", auth, adminOnly, async (req, res) => {
  const id = oid(req.params.id); if (!id) return res.status(400).json({ error: "Invalid order id" });
  const orders = await col("orders"); const order = await orders.findOne({ _id: id }); if (!order) return res.status(404).json({ error: "Order not found" });
  const current = order.customer || {};
  const customer = {
    ...current,
    name: req.body?.name !== undefined ? String(req.body.name).trim() : current.name,
    email: req.body?.email !== undefined ? String(req.body.email).trim().toLowerCase() : current.email,
    phone: req.body?.phone !== undefined ? String(req.body.phone).trim() : current.phone,
    address: req.body?.address !== undefined ? req.body.address : current.address
  };
  await orders.updateOne({ _id: id }, { $set: { customer, updatedAt: new Date() } });
  res.json(clean(await orders.findOne({ _id: id })));
});

app.patch("/api/orders/:id/meta", auth, adminOnly, async(req,res)=>{const id=oid(req.params.id);if(!id)return res.status(400).json({error:"Invalid order id"});const allowed={};if(req.body?.note!==undefined)allowed.note=String(req.body.note);if(req.body?.tags!==undefined)allowed.tags=Array.isArray(req.body.tags)?req.body.tags.map(String):String(req.body.tags).split(",").map(x=>x.trim()).filter(Boolean);allowed.updatedAt=new Date();await (await col("orders")).updateOne({_id:id},{$set:allowed});await logAdmin("update","order",id,{fields:Object.keys(allowed)},req);res.json(clean(await (await col("orders")).findOne({_id:id})));});
app.post("/api/orders/:id/refund", auth, adminOnly, async (req, res) => {
  try {
    if (!razorpay) return res.status(503).json({ error: "Razorpay is not configured" });
    const id = oid(req.params.id);
    if (!id) return res.status(400).json({ error: "Invalid order id" });
    const orders = await col("orders");
    const order = await orders.findOne({ _id: id });
    if (!order) return res.status(404).json({ error: "Order not found" });
    if (!order.razorpayPaymentId) return res.status(400).json({ error: "This order has no captured Razorpay payment" });
    if (!["paid", "partially_refunded"].includes(order.paymentStatus)) return res.status(400).json({ error: "Only captured, refundable payments can be refunded" });
    const totalPaid = Math.max(0, Number(order.total || 0));
    const refunds = Array.isArray(order.refunds) ? order.refunds : (order.refund ? [order.refund] : []);
    const refundedAmount = refunds.filter(r => !["failed", "cancelled"].includes(String(r.status || "").toLowerCase())).reduce((sum, r) => sum + Number(r.amount || 0), 0);
    const requested = Number(req.body?.amount);
    const amount = Number.isFinite(requested) && requested > 0 ? requested : totalPaid - refundedAmount;
    const remaining = Math.max(0, totalPaid - refundedAmount);
    if (amount <= 0) return res.status(400).json({ error: "Refund amount must be greater than zero" });
    if (amount > remaining + 0.01) return res.status(400).json({ error: `Maximum refundable amount is ₹${remaining.toFixed(2)}` });

    const lockUntil = new Date(Date.now() + 2 * 60 * 1000);
    const locked = await orders.updateOne({ _id: id, $or: [{ refundInProgressUntil: { $exists: false } }, { refundInProgressUntil: { $lte: new Date() } }] }, { $set: { refundInProgressUntil: lockUntil, updatedAt: new Date() } });
    if (locked.modifiedCount !== 1) return res.status(409).json({ error: "Another refund is already being processed for this order" });

    try {
      const refund = await razorpay.payments.refund(order.razorpayPaymentId, { amount: Math.round(amount * 100), notes: { order: order.orderNumber || String(order._id), reason: String(req.body?.reason || "admin_refund") } });
      const entry = { id: refund.id, amount: amount, status: refund.status || "processed", reason: String(req.body?.reason || "admin_refund"), createdAt: new Date(), admin: req.admin?.email || "admin" };
      const nextRefunded = refundedAmount + amount;
      const paymentStatus = nextRefunded >= totalPaid - 0.01 ? "refunded" : "partially_refunded";
      await orders.updateOne({ _id: id }, { $push: { refunds: entry }, $set: { refundedAmount: nextRefunded, refund: entry, paymentStatus, updatedAt: new Date() }, $unset: { refundInProgressUntil: "" } });
      await logAdmin("refund", "order", id, { amount, refundId: refund.id, paymentStatus }, req);
      res.json(clean(await orders.findOne({ _id: id })));
    } catch (error) {
      await orders.updateOne({ _id: id }, { $unset: { refundInProgressUntil: "" }, $set: { updatedAt: new Date() } });
      throw error;
    }
  } catch (e) {
    console.error("Refund error", e);
    res.status(502).json({ error: e.error?.description || e.message || "Refund failed" });
  }
});

app.patch("/api/orders/:id/status", auth, adminOnly, async (req, res) => {
  const id = oid(req.params.id); const status = String(req.body?.status || "").toLowerCase();
  const allowed = new Set(["pending", "confirmed", "processing", "shipped", "delivered", "cancelled", "expired"]);
  if (!id || !allowed.has(status)) return res.status(400).json({ error: "Invalid order status" });
  const orders = await col("orders"); const order = await orders.findOne({ _id: id }); if (!order) return res.status(404).json({ error: "Order not found" });
  if (status === "cancelled" && order.inventoryReserved && order.paymentStatus !== "paid") await releaseReservation(order.razorpayOrderId, "cancelled");
  await orders.updateOne({ _id: id }, { $set: { status, updatedAt: new Date() } });
  res.json(clean(await orders.findOne({ _id: id })));
});

app.get("/api/admin/shipping/config", auth, adminOnly, async (_req, res) => {
  res.json({ provider: "shiprocket", configured: shiprocketConfigured(), pickupConfigured: Boolean(process.env.SHIPROCKET_PICKUP_LOCATION && process.env.SHIPROCKET_PICKUP_PINCODE) });
});
app.get("/api/orders/:id/shipping/couriers", auth, adminOnly, async (req, res) => {
  try {
    const id = oid(req.params.id); if (!id) return res.status(400).json({ error: "Invalid order id" });
    const order = await (await col("orders")).findOne({ _id: id }); if (!order) return res.status(404).json({ error: "Order not found" });
    const address = orderShippingAddress(order); const pickup = String(process.env.SHIPROCKET_PICKUP_PINCODE || "");
    if (!pickup || !address.pincode) return res.status(400).json({ error: "Set SHIPROCKET_PICKUP_PINCODE and ensure the customer's pincode is present." });
    const weight = Number(order.package?.weight || process.env.SHIPROCKET_DEFAULT_WEIGHT || 0.5);
    const cod = order.paymentStatus === "paid" ? 0 : 1;
    const data = await shiprocketRequest(`/courier/serviceability/?pickup_postcode=${encodeURIComponent(pickup)}&delivery_postcode=${encodeURIComponent(address.pincode)}&weight=${encodeURIComponent(weight)}&cod=${cod}&declared_value=${encodeURIComponent(Number(order.total)||0)}`);
    const couriers = (data.data?.available_courier_companies || []).map(c => ({ id: c.courier_company_id, name: c.courier_name, freight: c.freight_charge, etd: c.etd, rating: c.rating, cod: c.cod }));
    res.json({ couriers });
  } catch (error) { console.error("Shipping serviceability error:", error); res.status(502).json({ error: error.message || "Could not fetch shipping couriers" }); }
});
app.post("/api/orders/:id/shipping/create", auth, adminOnly, async (req, res) => {
  try {
    const id = oid(req.params.id); if (!id) return res.status(400).json({ error: "Invalid order id" });
    const orders = await col("orders"); const order = await orders.findOne({ _id: id }); if (!order) return res.status(404).json({ error: "Order not found" });
    if (order.shipment?.shipmentId) return res.status(409).json({ error: "A Shiprocket shipment already exists for this order" });
    const address = orderShippingAddress(order); const name = splitName(order.customer?.name);
    if (!address.address || !address.city || !address.state || !address.pincode || !order.customer?.phone) return res.status(400).json({ error: "Complete customer shipping address and phone are required before creating a shipment." });
    const settingDocs = await (await adminCol("settings")).find({ key: { $in: ["SHIPROCKET_PICKUP_LOCATION","SHIPROCKET_CHANNEL_ID","SHIPROCKET_DEFAULT_WEIGHT","SHIPROCKET_DEFAULT_LENGTH","SHIPROCKET_DEFAULT_WIDTH","SHIPROCKET_DEFAULT_HEIGHT"] } }).toArray();
    const storeSettings = Object.fromEntries(settingDocs.map(x=>[x.key,x.value]));
    const packageData = { weight: Number(order.package?.weight || storeSettings.SHIPROCKET_DEFAULT_WEIGHT || process.env.SHIPROCKET_DEFAULT_WEIGHT || 0.5), length: Number(order.package?.length || storeSettings.SHIPROCKET_DEFAULT_LENGTH || process.env.SHIPROCKET_DEFAULT_LENGTH || 20), breadth: Number(order.package?.width || storeSettings.SHIPROCKET_DEFAULT_WIDTH || process.env.SHIPROCKET_DEFAULT_WIDTH || 15), height: Number(order.package?.height || storeSettings.SHIPROCKET_DEFAULT_HEIGHT || process.env.SHIPROCKET_DEFAULT_HEIGHT || 10) };
    const payload = {
      order_id: String(order.orderNumber || order._id), order_date: new Date(order.createdAt || Date.now()).toISOString().slice(0,19).replace("T", " "), pickup_location: String(storeSettings.SHIPROCKET_PICKUP_LOCATION || process.env.SHIPROCKET_PICKUP_LOCATION || "Primary"), channel_id: storeSettings.SHIPROCKET_CHANNEL_ID || process.env.SHIPROCKET_CHANNEL_ID || "", comment: "Aniverse online order",
      billing_customer_name: name.first, billing_last_name: name.last, billing_address: address.address, billing_city: address.city, billing_pincode: address.pincode, billing_state: address.state, billing_country: address.country, billing_email: order.customer?.email || "", billing_phone: order.customer.phone,
      shipping_is_billing: true, shipping_customer_name: name.first, shipping_last_name: name.last, shipping_address: address.address, shipping_city: address.city, shipping_pincode: address.pincode, shipping_state: address.state, shipping_country: address.country, shipping_email: order.customer?.email || "", shipping_phone: order.customer.phone,
      order_items: (order.items || []).map(i => ({ name: i.name || i.title || "Aniverse Product", sku: String(i.productId || i.sku || "SKU"), units: Number(i.qty || i.quantity || 1), selling_price: Number(i.price || 0), discount: 0, tax: 0, hsn: i.hsn || "" })), payment_method: order.paymentStatus === "paid" ? "Prepaid" : "COD", sub_total: Number(order.subtotal || order.total || 0), length: packageData.length, breadth: packageData.breadth, height: packageData.height, weight: packageData.weight
    };
    const data = await shiprocketRequest("/orders/create/adhoc", { method: "POST", body: JSON.stringify(payload) });
    const shipping = { provider: "shiprocket", orderId: data.order_id || data.order_id?.toString?.() || null, shipmentId: data.shipment_id || null, status: "created", createdAt: new Date(), package: packageData };
    await orders.updateOne({ _id: id }, { $set: { shipment: shipping, updatedAt: new Date() } });
    res.json({ shipping, raw: data });
  } catch (error) { console.error("Shiprocket create error:", error); res.status(502).json({ error: error.message || "Could not create shipping order" }); }
});
app.post("/api/orders/:id/shipping/assign", auth, adminOnly, async (req, res) => {
  try {
    const id = oid(req.params.id); const courierId = Number(req.body?.courierId); if (!id || !courierId) return res.status(400).json({ error: "Courier ID is required" });
    const orders = await col("orders"); const order = await orders.findOne({ _id: id }); if (!order?.shipment?.shipmentId) return res.status(400).json({ error: "Create the Shiprocket shipment first" });
    const data = await shiprocketRequest("/courier/assign/awb", { method: "POST", body: JSON.stringify({ shipment_id: order.shipment.shipmentId, courier_id: courierId }) });
    const company = data.response?.data?.courier_name || data.data?.courier_name || null; const awb = data.response?.data?.awb_code || data.data?.awb_code || null;
    await orders.updateOne({ _id: id }, { $set: { "shipment.courierId": courierId, "shipment.courier": company, "shipment.awb": awb, "shipment.status": "awb_assigned", "shipment.updatedAt": new Date(), updatedAt: new Date(), status: "shipped" } });
    res.json(clean(await orders.findOne({ _id: id })));
  } catch (error) { console.error("Shiprocket assign error:", error); res.status(502).json({ error: error.message || "Could not assign courier" }); }
});
app.get("/api/orders/:id/shipping/track", auth, adminOnly, async (req, res) => {
  try { const id=oid(req.params.id); if(!id) return res.status(400).json({error:"Invalid order id"}); const order=await (await col("orders")).findOne({_id:id}); const awb=order?.shipment?.awb; if(!awb) return res.status(400).json({error:"No AWB assigned yet"}); const data=await shiprocketRequest(`/courier/track/awb/${encodeURIComponent(awb)}`); res.json(data); }
  catch(error){ res.status(502).json({error:error.message||"Could not fetch tracking"}); }
});

app.post("/api/categories", auth, adminOnly, async (req, res) => {
  const name = String(req.body?.name || "").trim(); if (!name) return res.status(400).json({ error: "Category name required" });
  const heroEnabled = req.body?.heroEnabled === true || req.body?.heroEnabled === "true";
  const categorySlug = String(req.body?.slug || slugify(name));
  const doc = { name, slug: categorySlug, image: String(req.body?.image || ""), heroEnabled, showInDirectory: req.body?.showInDirectory === undefined ? !heroEnabled && !ANIME_WORLD_SLUGS.has(categorySlug) : (req.body?.showInDirectory === true || req.body?.showInDirectory === "true"), heroImage: String(req.body?.heroImage || ""), heroTag: String(req.body?.heroTag || ""), heroDescription: String(req.body?.heroDescription || ""), heroOrder: Number.isFinite(Number(req.body?.heroOrder)) ? Number(req.body.heroOrder) : 0, createdAt: new Date(), updatedAt: new Date() };
  const exists = await (await col("categories")).findOne({ slug: doc.slug }); if (exists) return res.status(409).json({ error: "A category with this slug already exists" });
  const r = await (await col("categories")).insertOne(doc); res.status(201).json(clean({ ...doc, _id: r.insertedId }));
});
app.put("/api/categories/:id", auth, adminOnly, async (req, res) => {
  const id = oid(req.params.id); if (!id) return res.status(400).json({ error: "Invalid category id" });
  const categories = await col("categories"); const old = await categories.findOne({ _id: id }); if (!old) return res.status(404).json({ error: "Category not found" });
  const update = { updatedAt: new Date() }; if (req.body?.name !== undefined) update.name = String(req.body.name).trim(); if (req.body?.slug !== undefined) update.slug = String(req.body.slug).trim(); if (req.body?.image !== undefined) update.image = String(req.body.image); if (req.body?.heroEnabled !== undefined) update.heroEnabled = req.body.heroEnabled === true || req.body.heroEnabled === "true"; if (req.body?.showInDirectory !== undefined) update.showInDirectory = req.body.showInDirectory === true || req.body.showInDirectory === "true"; if (req.body?.heroImage !== undefined) update.heroImage = String(req.body.heroImage); if (req.body?.heroTag !== undefined) update.heroTag = String(req.body.heroTag); if (req.body?.heroDescription !== undefined) update.heroDescription = String(req.body.heroDescription); if (req.body?.heroOrder !== undefined) update.heroOrder = Number.isFinite(Number(req.body.heroOrder)) ? Number(req.body.heroOrder) : 0;
  if (update.heroEnabled === true && req.body?.showInDirectory === undefined) update.showInDirectory = false;
  if (update.showInDirectory === undefined) update.showInDirectory = defaultShowInDirectory({ ...old, ...update });
  await categories.updateOne({ _id: id }, { $set: update });
  if (update.name && update.name !== old.name) { const products = await col("products"); await products.updateMany({ categories: old.name }, { $set: { "categories.$[cat]": update.name } }, { arrayFilters: [{ cat: old.name }] }); await products.updateMany({ category: old.name }, { $set: { category: update.name } }); }
  res.json(clean(await categories.findOne({ _id: id })));
});
app.delete("/api/categories/:id", auth, adminOnly, async (req, res) => {
  const id = oid(req.params.id); if (!id) return res.status(400).json({ error: "Invalid category id" });
  const categories = await col("categories");
  const c = await categories.findOne({ _id: id }); if (!c) return res.status(404).json({ error: "Category not found" });
  await categories.deleteOne({ _id: id });
  const products = await col("products");
  await products.updateMany({ categories: c.name }, { $pull: { categories: c.name } });
  await products.updateMany({ category: c.name }, { $set: { category: "" } });
  res.json({ ok: true });
});


// Shopify-style admin extensions: analytics, inventory history, bulk actions, discounts,
// draft orders, files, settings, activity log and CSV exports.
const adminCollections = {
  discounts: process.env.DISCOUNTS_COLLECTION || "discounts",
  drafts: process.env.DRAFT_ORDERS_COLLECTION || "draftOrders",
  settings: process.env.SETTINGS_COLLECTION || "storeSettings",
  activity: process.env.ACTIVITY_COLLECTION || "adminActivity",
  inventory: process.env.INVENTORY_HISTORY_COLLECTION || "inventoryAdjustments"
};
async function adminCol(name) { if (!db) throw new Error("Database not connected"); return db.collection(adminCollections[name]); }
async function logAdmin(action, entity, entityId, details = {}, req = null) {
  try { await (await adminCol("activity")).insertOne({ action, entity, entityId: entityId ? String(entityId) : null, details, admin: req?.admin?.email || "system", createdAt: new Date() }); } catch (e) { console.error("Activity log:", e.message); }
}
function parseDateRange(value) {
  const days = value === "7d" ? 7 : value === "90d" ? 90 : value === "365d" ? 365 : 30;
  const start = new Date(); start.setHours(0,0,0,0); start.setDate(start.getDate() - (days - 1));
  return { days, start };
}
function dateKey(d) { const x = new Date(d); return x.toISOString().slice(0,10); }
function csvEscape(value) { const s = String(value ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s; }

app.get("/api/admin/analytics", auth, adminOnly, async (req, res) => {
  try {
    const { days, start } = parseDateRange(String(req.query.range || "30d"));
    const orders = await col("orders");
    const paidMatch = { paymentStatus: "paid", createdAt: { $gte: start } };
    const [summary, daily, topProducts, statuses] = await Promise.all([
      orders.aggregate([{ $match: paidMatch }, { $group: { _id: null, revenue: { $sum: { $ifNull: ["$total",0] } }, orders: { $sum:1 }, avg: { $avg: { $ifNull: ["$total",0] } } } }]).toArray(),
      orders.aggregate([{ $match: paidMatch }, { $group: { _id: { $dateToString: { format:"%Y-%m-%d", date:"$createdAt" } }, revenue: { $sum: { $ifNull:["$total",0] } }, orders:{ $sum:1 } } }, { $sort:{ _id:1 } }]).toArray(),
      orders.aggregate([{ $match: { paymentStatus:"paid" } }, { $unwind:"$items" }, { $group:{ _id:"$items.name", units:{ $sum:{ $ifNull:["$items.qty", "$items.quantity", 1] } }, revenue:{ $sum:{ $multiply:[{ $ifNull:["$items.price",0] }, { $ifNull:["$items.qty", "$items.quantity",1] }] } } } }, { $sort:{ revenue:-1 } }, { $limit:10 }]).toArray(),
      orders.aggregate([{ $group:{ _id:{ $ifNull:["$status","unknown"] }, count:{ $sum:1 } } }, { $sort:{ count:-1 } }]).toArray()
    ]);
    const byDay = new Map(daily.map(x => [x._id, x]));
    const series=[]; for(let i=0;i<days;i++){const d=new Date(start);d.setDate(start.getDate()+i);const key=dateKey(d);series.push({date:key,revenue:byDay.get(key)?.revenue||0,orders:byDay.get(key)?.orders||0});}
    res.json({ range:`${days}d`, revenue:summary[0]?.revenue||0, orders:summary[0]?.orders||0, averageOrderValue:summary[0]?.avg||0, series, topProducts:topProducts.map(clean), statuses:statuses.map(clean) });
  } catch (e) { console.error(e); res.status(500).json({error:"Could not load analytics"}); }
});

app.get("/api/admin/inventory", auth, adminOnly, async (req,res)=>{
  try {
    const q=String(req.query.q||"").trim(), low=String(req.query.low||"") === "true";
    const filter={};
    if(q) filter.$or=[{name:{$regex:q,$options:"i"}},{title:{$regex:q,$options:"i"}},{sku:{$regex:q,$options:"i"}}];
    if(low) filter.$or=[...(filter.$or||[]),{stock:{$lte:5}},{inventory:{$lte:5}},{quantity:{$lte:5}},{inventoryQuantity:{$lte:5}}];
    const docs=await (await col("products")).find(filter).sort({updatedAt:-1,createdAt:-1}).limit(1000).toArray();
    res.json(docs.map(publicProduct));
  }catch(e){res.status(500).json({error:"Could not load inventory"});}
});
app.get("/api/admin/inventory/:id/history", auth, adminOnly, async (req,res)=>{
  const id=String(req.params.id); res.json(clean(await (await adminCol("inventory")).find({productId:id}).sort({createdAt:-1}).limit(100).toArray()));
});

app.post("/api/admin/products/bulk", auth, adminOnly, async (req,res)=>{
  try {
    const ids=(Array.isArray(req.body?.ids)?req.body.ids:[]).map(oid).filter(Boolean); const action=String(req.body?.action||"");
    if(!ids.length) return res.status(400).json({error:"Select at least one product"});
    const products=await col("products"); let result;
    if(action==="activate") result=await products.updateMany({_id:{$in:ids}},{$set:{active:true,updatedAt:new Date()}});
    else if(action==="hide") result=await products.updateMany({_id:{$in:ids}},{$set:{active:false,updatedAt:new Date()}});
    else if(action==="featured") result=await products.updateMany({_id:{$in:ids}},{$set:{featured:true,updatedAt:new Date()}});
    else if(action==="unfeatured") result=await products.updateMany({_id:{$in:ids}},{$set:{featured:false,updatedAt:new Date()}});
    else if(action==="preorder") result=await products.updateMany({_id:{$in:ids}},{$set:{isPreorder:true,badge:"PRE-ORDER",updatedAt:new Date()}});
    else if(action==="category"){const category=String(req.body?.category||"").trim();if(!category)return res.status(400).json({error:"Category is required"});result=await products.updateMany({_id:{$in:ids}},[{$set:{categories:{$setUnion:[{$ifNull:["$categories",[]]},[category]]},updatedAt:new Date()}}]);}
    else if(action==="delete"){result=await products.deleteMany({_id:{$in:ids}});}
    else return res.status(400).json({error:"Unsupported bulk action"});
    await logAdmin("bulk_"+action,"product",null,{count:result.modifiedCount||result.deletedCount||0},req); res.json({ok:true,count:result.modifiedCount||result.deletedCount||0});
  }catch(e){res.status(500).json({error:e.message||"Bulk action failed"});}
});

// Inventory adjustment history is appended to the existing inventory endpoint.
const originalInventoryRouteNote = true;

app.get("/api/discounts", auth, adminOnly, async (_req,res)=>res.json(clean(await (await adminCol("discounts")).find({}).sort({createdAt:-1}).limit(500).toArray())));
app.post("/api/discounts", auth, adminOnly, async (req,res)=>{
  try{
    const code=String(req.body?.code||"").trim().toUpperCase(); if(!code)return res.status(400).json({error:"Discount code is required"});
    const exists=await (await adminCol("discounts")).findOne({code}); if(exists)return res.status(409).json({error:"Discount code already exists"});
    const doc={code,type:req.body?.type==="fixed"?"fixed":"percentage",value:Math.max(0,Number(req.body?.value)||0),minimumAmount:Math.max(0,Number(req.body?.minimumAmount)||0),usageLimit:req.body?.usageLimit?Math.max(0,Number(req.body.usageLimit)):null,usedCount:0,active:req.body?.active!==false,startsAt:req.body?.startsAt?new Date(req.body.startsAt):null,endsAt:req.body?.endsAt?new Date(req.body.endsAt):null,createdAt:new Date(),updatedAt:new Date()};
    if(doc.type==="percentage"&&doc.value>100)return res.status(400).json({error:"Percentage cannot exceed 100"});
    const r=await (await adminCol("discounts")).insertOne(doc); await logAdmin("create","discount",r.insertedId,{code},req); res.status(201).json(clean({...doc,_id:r.insertedId}));
  }catch(e){res.status(500).json({error:e.message||"Could not create discount"});}
});
app.patch("/api/discounts/:id", auth, adminOnly, async(req,res)=>{try{const id=oid(req.params.id);if(!id)return res.status(400).json({error:"Invalid discount id"});const allowed={};for(const k of ["type","value","minimumAmount","usageLimit","active","startsAt","endsAt"])if(req.body?.[k]!==undefined)allowed[k]=req.body[k];if(allowed.value!==undefined)allowed.value=Number(allowed.value)||0;if(allowed.type!==undefined&&allowed.type!=="fixed"&&allowed.type!=="percentage")return res.status(400).json({error:"Invalid discount type"});allowed.updatedAt=new Date();await (await adminCol("discounts")).updateOne({_id:id},{$set:allowed});res.json(clean(await (await adminCol("discounts")).findOne({_id:id})));}catch(e){res.status(500).json({error:e.message||"Could not update discount"});}});
app.delete("/api/discounts/:id", auth, adminOnly, async(req,res)=>{const id=oid(req.params.id);if(!id)return res.status(400).json({error:"Invalid discount id"});await (await adminCol("discounts")).deleteOne({_id:id});res.json({ok:true});});
app.post("/api/discounts/validate", async(req,res)=>{try{const code=String(req.body?.code||"").trim().toUpperCase(),subtotal=Number(req.body?.subtotal)||0;if(!code)return res.status(400).json({error:"Discount code required"});const d=await (await adminCol("discounts")).findOne({code,active:true});if(!d)return res.status(404).json({error:"Invalid or inactive discount code"});const now=new Date();if(d.startsAt&&new Date(d.startsAt)>now||d.endsAt&&new Date(d.endsAt)<now)return res.status(400).json({error:"This discount is outside its valid dates"});if(d.usageLimit&&Number(d.usedCount||0)>=Number(d.usageLimit))return res.status(400).json({error:"This discount has reached its usage limit"});if(subtotal<Number(d.minimumAmount||0))return res.status(400).json({error:`Minimum order value is ₹${Number(d.minimumAmount).toLocaleString("en-IN")}`});const amount=d.type==="fixed"?Math.min(subtotal,Number(d.value)||0):subtotal*Math.min(100,Number(d.value)||0)/100;res.json({valid:true,code,amount,discount:d});}catch(e){res.status(500).json({error:e.message||"Could not validate discount"});}});

app.get("/api/draft-orders", auth, adminOnly, async (_req, res) => res.json(clean(await (await adminCol("drafts")).find({}).sort({ createdAt: -1 }).limit(500).toArray())));
app.post("/api/draft-orders", auth, adminOnly, async (req, res) => {
  try {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!items.length) return res.status(400).json({ error: "Add at least one product" });
    const products = await col("products");
    const normalized = [];
    for (const x of items) {
      const p = await products.findOne({ _id: oid(x.productId) });
      if (!p || p.active === false) continue;
      const qty = Math.max(1, Math.min(99, Number(x.qty) || 1));
      normalized.push({ productId: String(p._id), name: productName(p), price: moneyNumber(p.price), qty, image: productImages(p)[0] || "" });
    }
    if (!normalized.length) return res.status(400).json({ error: "No valid products" });
    const subtotal = normalized.reduce((s, x) => s + x.price * x.qty, 0);
    const shipping = Math.max(0, Number(req.body?.shipping) || 0);
    const discount = Math.max(0, Math.min(subtotal, Number(req.body?.discount) || 0));
    const total = Math.max(0, subtotal - discount + shipping);
    const doc = { draftNumber: `DRAFT-${Date.now()}`, items: normalized, customer: req.body.customer || {}, subtotal, discount, shipping, total, status: "open", note: String(req.body.note || ""), createdAt: new Date(), updatedAt: new Date() };
    const r = await (await adminCol("drafts")).insertOne(doc);
    await logAdmin("create", "draft_order", r.insertedId, { draftNumber: doc.draftNumber }, req);
    res.status(201).json(clean({ ...doc, _id: r.insertedId }));
  } catch (e) { res.status(500).json({ error: e.message || "Could not create draft order" }); }
});
app.patch("/api/draft-orders/:id", auth, adminOnly, async (req, res) => {
  try {
    const id = oid(req.params.id); if (!id) return res.status(400).json({ error: "Invalid draft id" });
    const draft = await (await adminCol("drafts")).findOne({ _id: id }); if (!draft) return res.status(404).json({ error: "Draft order not found" });
    const allowed = {};
    for (const k of ["customer", "note", "status", "shipping", "discount"]) if (req.body?.[k] !== undefined) allowed[k] = req.body[k];
    if (Array.isArray(req.body?.items)) {
      const products = await col("products"); const items=[];
      for (const x of req.body.items) { const p=await products.findOne({_id:oid(x.productId)}); if(p) items.push({productId:String(p._id),name:productName(p),price:moneyNumber(p.price),qty:Math.max(1,Math.min(99,Number(x.qty)||1)),image:productImages(p)[0]||""}); }
      allowed.items=items; allowed.subtotal=items.reduce((s,x)=>s+x.price*x.qty,0);
    }
    const subtotal = allowed.subtotal ?? Number(draft.subtotal || 0); const discount = Math.max(0, Math.min(subtotal, Number(allowed.discount ?? draft.discount ?? 0))); const shipping = Math.max(0, Number(allowed.shipping ?? draft.shipping ?? 0));
    allowed.discount=discount; allowed.shipping=shipping; allowed.total=Math.max(0,subtotal-discount+shipping); allowed.updatedAt=new Date();
    await (await adminCol("drafts")).updateOne({_id:id},{$set:allowed});
    res.json(clean(await (await adminCol("drafts")).findOne({_id:id})));
  } catch(e) { res.status(500).json({error:e.message||"Could not update draft order"}); }
});
app.post("/api/draft-orders/:id/convert", auth, adminOnly, async (req, res) => {
  try {
    if (!razorpay) return res.status(503).json({ error: "Razorpay is not configured" });
    const id=oid(req.params.id); if(!id) return res.status(400).json({error:"Invalid draft id"});
    const drafts=await adminCol("drafts"), draft=await drafts.findOne({_id:id}); if(!draft) return res.status(404).json({error:"Draft order not found"});
    if(["converted","cancelled"].includes(String(draft.status))) return res.status(409).json({error:"Draft order is already closed"});
    const customer=draft.customer||{}; const name=String(customer.name||"").trim(), email=String(customer.email||"").trim().toLowerCase(), phone=String(customer.phone||"").replace(/\D/g,"");
    if(name.length<2 || !/^\S+@\S+\.\S+$/.test(email) || phone.length<10) return res.status(400).json({error:"Draft customer must have a valid name, email and phone before conversion"});
    const quote={normalized:draft.items||[],subtotal:Number(draft.subtotal||0),discount:Number(draft.discount||0),shipping:Number(draft.shipping||0),total:Number(draft.total||0)};
    if(!quote.normalized.length || quote.total<=0) return res.status(400).json({error:"Draft order has no valid items"});
    const receipt=`ANV-DRAFT-${Date.now()}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
    const rpOrder=await razorpay.orders.create({amount:Math.round(quote.total*100),currency:"INR",receipt,notes:{brand:"Aniverse",source:"draft_order",draftId:String(id),email}});
    const session=client.startSession(); let orderId;
    try { await session.withTransaction(async()=>{ await reserveQuotedStock(quote.normalized,session); const doc={orderNumber:receipt,customerId:null,items:quote.normalized,customer:{...customer,name,email,phone},subtotal:quote.subtotal,discount:quote.discount,shipping:quote.shipping,total:quote.total,currency:"INR",status:"pending",paymentStatus:"created",inventoryReserved:true,reservedUntil:new Date(Date.now()+reservationMinutes*60*1000),razorpayOrderId:rpOrder.id,source:"draft_order",draftOrderId:id,createdAt:new Date(),updatedAt:new Date()}; const r=await (await col("orders")).insertOne(doc,{session}); orderId=r.insertedId; await drafts.updateOne({_id:id},{$set:{status:"converted",convertedOrderId:orderId,convertedAt:new Date(),updatedAt:new Date()}},{session}); }); } finally { await session.endSession(); }
    await logAdmin("convert","draft_order",id,{orderId:String(orderId),orderNumber:receipt},req);
    res.status(201).json({orderId:String(orderId),orderNumber:receipt,razorpayOrderId:rpOrder.id,amount:rpOrder.amount,currency:rpOrder.currency,keyId:process.env.RAZORPAY_KEY_ID});
  } catch(e) { res.status(e.message?.includes("Stock changed")||e.message?.includes("Insufficient")?409:500).json({error:e.message||"Could not convert draft order"}); }
});
app.delete("/api/draft-orders/:id", auth, adminOnly, async (req,res)=>{const id=oid(req.params.id);if(!id)return res.status(400).json({error:"Invalid draft id"});await (await adminCol("drafts")).updateOne({_id:id},{$set:{status:"cancelled",updatedAt:new Date()}});res.json({ok:true});});

app.get("/api/admin/files", auth, adminOnly, async(_req,res)=>{try{if(!imageKitConfigured())return res.status(503).json({error:"ImageKit is not configured."});const [files,usage]=await Promise.all([listImageKitFiles({limit:1000,path:"/aniverse/"}),getImageKitUsage().catch(()=>null)]);res.json(files.map(f=>({fileId:f.fileId,name:f.name,url:f.url,filePath:f.filePath,size:Number(f.size||0),createdAt:f.createdAt||f.updatedAt||null,thumbnailUrl:f.thumbnailUrl||f.url,folder:f.filePath?.split("/").slice(0,-1).join("/")||"/"})).concat(usage?[]:[]).sort((a,b)=>new Date(b.createdAt||0)-new Date(a.createdAt||0)));}catch(e){res.status(500).json({error:e.message||"Could not list files"});}});
app.get("/api/admin/imagekit-usage", auth, adminOnly, async(_req,res)=>{try{if(!imageKitConfigured())return res.status(503).json({error:"ImageKit is not configured."});res.json(await getImageKitUsage());}catch(e){res.status(500).json({error:e.message||"Could not load ImageKit usage"});}});
app.get("/api/admin/settings", auth, adminOnly, async(_req,res)=>{const docs=await (await adminCol("settings")).find({}).toArray();const settings={shippingFreeThreshold:999,standardShipping:79,storeName:"Aniverse",supportEmail:"aniversemerchofficial@gmail.com",supportPhone:"+919505700496",currency:"INR",timezone:"Asia/Kolkata",announcement:"FREE SHIPPING ON ORDERS ABOVE ₹999 • SHOP ANIVERSE",SHIPROCKET_PICKUP_LOCATION:process.env.SHIPROCKET_PICKUP_LOCATION||"Primary",SHIPROCKET_PICKUP_PINCODE:process.env.SHIPROCKET_PICKUP_PINCODE||"",SHIPROCKET_DEFAULT_WEIGHT:process.env.SHIPROCKET_DEFAULT_WEIGHT||"0.5",SHIPROCKET_CHANNEL_ID:process.env.SHIPROCKET_CHANNEL_ID||"",...Object.fromEntries(docs.map(x=>[x.key,x.value]))};res.json(settings);});
app.put("/api/admin/settings", auth, adminOnly, async(req,res)=>{const entries=Object.entries(req.body||{});const c=await adminCol("settings");for(const [key,value] of entries){await c.updateOne({key},{$set:{key,value,updatedAt:new Date()}},{upsert:true});}await logAdmin("update","settings",null,{keys:entries.map(x=>x[0])},req);res.json(req.body);});
app.get("/api/admin/activity", auth, adminOnly, async(_req,res)=>res.json(clean(await (await adminCol("activity")).find({}).sort({createdAt:-1}).limit(100).toArray())));

app.get("/api/admin/staff", auth, adminOnly, async (_req,res)=>{
  const docs=await (await col("users")).find({role:{$in:["admin","staff"]}},{projection:{password:0,passwordHash:0,hash:0}}).sort({createdAt:-1}).toArray();
  res.json(docs.map(clean));
});
app.post("/api/admin/staff", auth, adminOnly, async(req,res)=>{
  try{const email=String(req.body?.email||"").trim().toLowerCase(),password=String(req.body?.password||"");if(!email||!password||password.length<8)return res.status(400).json({error:"Email and password (8+ characters) are required"});const users=await col("users");if(await users.findOne({email}))return res.status(409).json({error:"A user with this email already exists"});const doc={name:String(req.body?.name||email.split("@")[0]).trim(),email,role:req.body?.role==="admin"?"admin":"staff",status:req.body?.status||"active",permissions:Array.isArray(req.body?.permissions)?req.body.permissions:[],passwordHash:await bcrypt.hash(password,12),createdAt:new Date(),updatedAt:new Date()};const r=await users.insertOne(doc);await logAdmin("create","staff",r.insertedId,{email,role:doc.role},req);res.status(201).json(clean({...doc,_id:r.insertedId}));}catch(e){res.status(500).json({error:e.message||"Could not create staff"});}
});
app.patch("/api/admin/staff/:id", auth, adminOnly, async(req,res)=>{
  try{const id=oid(req.params.id);if(!id)return res.status(400).json({error:"Invalid staff id"});const users=await col("users"),allowed={};for(const k of ["name","role","status","permissions"])if(req.body?.[k]!==undefined)allowed[k]=k==="role"?(req.body[k]==="admin"?"admin":"staff"):req.body[k];if(req.body?.email!==undefined){const email=String(req.body.email).trim().toLowerCase();const conflict=await users.findOne({email,_id:{$ne:id}});if(conflict)return res.status(409).json({error:"Email already in use"});allowed.email=email;}if(req.body?.password)allowed.passwordHash=await bcrypt.hash(String(req.body.password),12);allowed.updatedAt=new Date();await users.updateOne({_id:id,role:{$in:["admin","staff"]}},{$set:allowed});res.json(clean(await users.findOne({_id:id},{projection:{password:0,passwordHash:0,hash:0}})));}catch(e){res.status(500).json({error:e.message||"Could not update staff"});}
});


app.get("/api/admin/export/:type", auth, adminOnly, async(req,res)=>{
  try{
    const type=String(req.params.type); let headers=[],rows=[];
    if(type==="products"){headers=["id","name","price","stock","categories","active","preorder"];const docs=await (await col("products")).find({}).toArray();rows=docs.map(p=>[p._id,productName(p),moneyNumber(p.price),moneyNumber(p.stock??p.inventory??p.quantity??p.inventoryQuantity),productCategories(p).join(" | "),p.active!==false,p.isPreorder||false]);}
    else if(type==="customers"){headers=["id","name","email","phone","city","state","pincode","status"];const docs=await (await col("users")).find({},{projection:{password:0,passwordHash:0,hash:0}}).toArray();rows=docs.map(u=>[u._id,u.name,u.email,u.phone,u.city,u.state,u.pincode||u.postalCode,u.status||"active"]);}
    else if(type==="orders"){headers=["id","orderNumber","customer","email","total","paymentStatus","status","createdAt","awb"];const docs=await (await col("orders")).find({}).sort({createdAt:-1}).toArray();rows=docs.map(o=>[o._id,o.orderNumber,o.customer?.name,o.customer?.email,o.total,o.paymentStatus,o.status,o.createdAt,o.shipment?.awb]);}
    else return res.status(400).json({error:"Unsupported export type"});
    const csv=[headers,...rows].map(r=>r.map(csvEscape).join(",")).join("\n");res.setHeader("Content-Type","text/csv; charset=utf-8");res.setHeader("Content-Disposition",`attachment; filename=aniverse-${type}-${Date.now()}.csv`);res.send(csv);
  }catch(e){res.status(500).json({error:"Export failed"});}
});

// Release abandoned checkout reservations.
setInterval(() => {
  if (!db) return;
  col("orders").then(async orders => {
    const expired = await orders.find({ inventoryReserved: true, paymentStatus: { $ne: "paid" }, reservedUntil: { $lte: new Date() } }, { projection: { razorpayOrderId: 1 } }).limit(25).toArray();
    for (const order of expired) releaseReservation(order.razorpayOrderId, "expired").catch(e => console.error("Reservation release:", e.message));
  }).catch(() => {});
}, 60_000);

app.get("/sitemap.xml", async (_req, res) => {
  try {
    const products = await (await col("products")).find({ active: { $ne: false } }, { projection: { slug: 1, updatedAt: 1 } }).limit(5000).toArray();
    const urls = ["/", "/shipping-policy.html", "/returns-refunds.html", "/cancellation-policy.html", "/privacy-policy.html", "/terms.html", "/faq.html", "/contact.html"];
    for (const p of products) if (p.slug) urls.push(`/product/${encodeURIComponent(String(p.slug))}`);
    const unique = [...new Set(urls)];
    const xml = `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${unique.map(u=>`<url><loc>https://www.aniverseofficial.in${u}</loc></url>`).join("")}</urlset>`;
    res.type("application/xml").send(xml);
  } catch { res.type("application/xml").send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>https://www.aniverseofficial.in/</loc></url></urlset>`); }
});

app.use("/uploads", express.static(uploadDir, { maxAge: "30d", immutable: true }));
app.use(express.static(path.join(process.cwd(), "public"), { maxAge: process.env.NODE_ENV === "production" ? "1h" : 0 }));
app.use("/admin", express.static(path.join(process.cwd(), "admin"), { maxAge: process.env.NODE_ENV === "production" ? "1h" : 0 }));
app.get("/admin/*splat", (_req, res) => res.sendFile(path.join(process.cwd(), "admin", "index.html")));
app.get("/product/:slug", async (req, res, next) => {
  try {
    const slug = String(req.params.slug || "").trim();
    if (!slug) return next();
    const p = await (await col("products")).findOne({ slug, active: { $ne: false } });
    if (!p) return next();
    const pub = publicProduct(p);
    const canonical = `https://www.aniverseofficial.in/product/${encodeURIComponent(slug)}`;
    const image = pub.images?.[0] || "https://www.aniverseofficial.in/";
    const availability = pub.stock > 0 ? "https://schema.org/InStock" : "https://schema.org/OutOfStock";
    const schema = {"@context":"https://schema.org","@type":"Product","name":pub.name,"image":pub.images||[image],"description":String(pub.description||"Anime collectible from Aniverse."),"sku":String(pub.sku||""),"brand":{"@type":"Brand","name":String(pub.vendor||"Aniverse")},"offers":{"@type":"Offer","url":canonical,"priceCurrency":"INR","price":String(pub.price),"availability":availability}};
    const escHtml=v=>String(v??"").replace(/[&<>\"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;"}[c]));
    res.type("html").send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escHtml(pub.name)} | Aniverse</title><meta name="description" content="${escHtml(String(pub.description||`${pub.name} available at Aniverse.`).slice(0,155))}"><link rel="canonical" href="${canonical}"><meta property="og:type" content="product"><meta property="og:title" content="${escHtml(pub.name)} | Aniverse"><meta property="og:image" content="${escHtml(image)}"><script type="application/ld+json">${JSON.stringify(schema).replace(/</g,"\\u003c")}</script><style>body{margin:0;background:#0a0a0a;color:#fff;font-family:Inter,system-ui,sans-serif}.wrap{max-width:1100px;margin:auto;padding:30px 22px 70px}.brand{display:inline-block;color:#fff;text-decoration:none;font-weight:900;letter-spacing:.12em}.hero{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:40px;align-items:center;margin-top:55px}.image{background:#15171b;border:1px solid #292d34;border-radius:16px;padding:25px}.image img{width:100%;height:560px;object-fit:contain}.kicker{color:#ff6500;font-size:11px;font-weight:900;letter-spacing:.15em}.title{font-size:clamp(38px,6vw,72px);line-height:.95;margin:12px 0}.price{font-size:28px;font-weight:900;margin:20px 0}.desc{color:#bbb;line-height:1.8}.cta{display:inline-block;margin-top:25px;background:#ff6500;color:#111;padding:15px 20px;text-decoration:none;font-weight:900}.note{color:#777;font-size:12px;margin-top:18px}@media(max-width:760px){.hero{grid-template-columns:1fr}.image img{height:380px}}</style></head><body><main class="wrap"><a class="brand" href="/">ANIVERSE</a><section class="hero"><div class="image"><img src="${escHtml(image)}" alt="${escHtml(pub.name)}"></div><div><div class="kicker">ANIVERSE / PRODUCT</div><h1 class="title">${escHtml(pub.name)}</h1><div class="price">₹${Number(pub.price||0).toLocaleString("en-IN")}</div><p class="desc">${escHtml(pub.description||"A carefully selected anime collectible made for fans and collectors.")}</p><a class="cta" href="/?product=${encodeURIComponent(String(pub._id||pub.id||""))}">VIEW IN STORE →</a><p class="note">Availability: ${pub.stock>0?"In stock":"Currently sold out"}</p></div></section></main></body></html>`);
  } catch (error) { next(error); }
});

app.get("*splat", (req, res, next) => { if (req.path.startsWith("/api/")) return next(); res.sendFile(path.join(process.cwd(), "public", "index.html")); });
app.use("/api", (_req, res) => res.status(404).json({ error: "API route not found" }));
app.use((error, _req, res, _next) => { console.error("Unhandled error:", error); res.status(error?.status || 500).json({ error: error?.message || "Internal server error" }); });

async function seedMerchandiseCategories() {
  // Create the initial merchandise directory once so the customer-facing
  // All Categories page contains the same non-anime categories shown in the
  // navigation. After this one-time seed, Admin has full control: hiding or
  // deleting a category will persist and it will not be recreated on restart.
  const settings = await adminCol("settings");
  const marker = await settings.findOne({ key: "merchandiseCategoriesSeededV1" });
  if (marker) return;

  const defaults = [
    ["Figurines", "figurines"],
    ["Premium Figures", "premium-figures"],
    ["Keychains", "keychains"],
    ["Katanas", "katanas"],
    ["Anime Lamps", "anime-lamps"],
    ["Merchandise", "merchandise"],
    ["Miniature Sets", "miniature-sets"],
    ["Funko Pop", "funko-pop"],
    ["Qposket", "qposket"],
    ["DIY Blocks", "diy-blocks"],
    ["Banpresto", "banpresto"]
  ];

  const categories = await col("categories");
  for (const [name, slug] of defaults) {
    const existing = await categories.findOne({ slug });
    if (!existing) {
      await categories.insertOne({
        name,
        slug,
        showInDirectory: true,
        heroEnabled: false,
        createdAt: new Date(),
        updatedAt: new Date()
      });
    } else if (existing.showInDirectory === undefined && existing.heroEnabled !== true && !ANIME_WORLD_SLUGS.has(slug)) {
      await categories.updateOne({ _id: existing._id }, { $set: { showInDirectory: true, updatedAt: new Date() } });
    }
  }

  await settings.updateOne(
    { key: "merchandiseCategoriesSeededV1" },
    { $set: { key: "merchandiseCategoriesSeededV1", value: true, updatedAt: new Date() } },
    { upsert: true }
  );
}

async function seedAnimeHeroCategories() {
  const seeds = [
    ["One Piece","one-piece.jpg","Featured universe","Set sail with the Straw Hat Crew and discover premium figures, collectibles and more from the Grand Line."],
    ["Naruto","naruto.jpg","Shinobi collection","Enter the Hidden Leaf and discover iconic shinobi and character collections."],
    ["Demon Slayer","demon-slayer.jpg","Breathing styles","Bring the Demon Slayer Corps to life with your favourite characters."],
    ["Jujutsu Kaisen","jujutsu-kaisen.jpg","Cursed energy","Discover sorcerers, curses and iconic character designs from JJK."],
    ["Bleach","bleach.jpg","Soul reapers","Enter the Soul Society and discover iconic Soul Reapers and collectibles."],
    ["Attack on Titan","attack-on-titan.jpg","Survey Corps","Stand with the Survey Corps and explore legendary characters from beyond the walls."],
    ["My Hero Academia","my-hero-academia.jpg","Plus Ultra","Go Plus Ultra with heroes and villains from a celebrated superpowered world."],
    ["Dragon Ball","dragon-ball.jpg","Saiyan power","Power up with legendary Saiyans, warriors and collectible figures."],
    ["Hunter x Hunter","hunter-x-hunter.jpg","Hunter world","Follow Gon, Killua and the Hunters through a world of adventure and discovery."],
    ["Chainsaw Man","chainsaw-man.jpg","Devil hunters","Step into the chaotic world of devil hunters and unforgettable characters."],
    ["Tokyo Revengers","tokyo-revengers.jpg","Time leap","Revisit the Tokyo Manji Gang and its most iconic characters."],
    ["Death Note","death-note.jpg","Dark collection","Enter the psychological world of Light, L and the mysterious Death Note."],
    ["Solo Leveling","solo-leveling.png","Shadow monarch","Enter the world of hunters, shadows and the Shadow Monarch."],
  ];
  const categories = await col("categories");
  for (let i = 0; i < seeds.length; i++) {
    const [name, file, tag, description] = seeds[i];
    const slug = slugify(name);
    const existing = await categories.findOne({ slug });
    const defaults = { heroEnabled: true, heroImage: `/images/hero/${file}`, heroTag: tag, heroDescription: description, heroOrder: i + 1 };
    if (!existing) {
      await categories.insertOne({ name, slug, image: defaults.heroImage, ...defaults, createdAt: new Date(), updatedAt: new Date() });
    } else if (existing.heroEnabled === undefined || (existing.heroEnabled === true && !existing.heroImage)) {
      await categories.updateOne({ _id: existing._id }, { $set: { ...defaults, updatedAt: new Date() } });
    }
  }
}

async function start() {
  const mongoUri = getMongoUri();
  requireEnv("JWT_SECRET");
  client = new MongoClient(mongoUri);
  if (process.env.NODE_ENV === "production") requireEnv("ADMIN_EMAIL");
  await client.connect(); db = client.db(process.env.MONGODB_DB || undefined);
  await supplierStockReport.init();
  await seedMerchandiseCategories();
  await seedAnimeHeroCategories();
  async function ensureIndexIfMissing(collection, key, options = {}) {
    // New optional admin collections may not exist yet. MongoDB throws
    // NamespaceNotFound when listIndexes() is called on those collections.
    // createIndex() will safely create the collection and index on demand.
    let indexes = [];
    try {
      indexes = await collection.listIndexes().toArray();
    } catch (error) {
      if (error?.code !== 26 && error?.codeName !== "NamespaceNotFound") throw error;
      return collection.createIndex(key, options);
    }
    const sameKey = indexes.find(index => JSON.stringify(index.key) === JSON.stringify(key));
    if (sameKey) return sameKey.name;
    return collection.createIndex(key, options);
  }
  await ensureIndexIfMissing(await col("products"), { name: 1 });
  await ensureIndexIfMissing(await col("orders"), { createdAt: -1 });
  await ensureIndexIfMissing(await col("orders"), { razorpayOrderId: 1 }, { unique: true, sparse: true });
  await ensureIndexIfMissing(await adminCol("discounts"), { code: 1 }, { unique: true });
  await ensureIndexIfMissing(await adminCol("activity"), { createdAt: -1 });
  await ensureIndexIfMissing(await adminCol("inventory"), { productId: 1, createdAt: -1 });
  await ensureIndexIfMissing(await adminCol("drafts"), { createdAt: -1 });
  app.listen(PORT, () => console.log(`Aniverse full stack running on http://localhost:${PORT}`));
}
async function shutdown(signal) { console.log(`${signal}: shutting down`); try { await client.close(); } finally { process.exit(0); } }
process.on("SIGINT", () => shutdown("SIGINT")); process.on("SIGTERM", () => shutdown("SIGTERM"));
start().catch(error => { console.error(error); process.exit(1); });
