(() => {
  "use strict";

  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];
  const EXPLICIT_API_BASE = window.ANIVERSE_API_BASE || "";
  let ACTIVE_API_BASE = EXPLICIT_API_BASE;

  function apiBases() {
    const bases = [];
    const add = (value) => {
      const normalized = String(value || "").replace(/\/$/, "");
      if (!bases.includes(normalized)) bases.push(normalized);
    };
    // Prefer the current origin first. The production Express app serves both
    // the storefront and API, so this avoids accidentally reading an older
    // API process on another local port. If the current origin is only a
    // frontend/dev server, api() rejects its HTML fallback and continues.
    if (!EXPLICIT_API_BASE) add("");
    if (!EXPLICIT_API_BASE) {
      const host = window.location.hostname;
      const isLocal = host === "localhost" || host === "127.0.0.1";
      if (isLocal && window.location.port !== "5000") add(`${window.location.protocol}//${host}:5000`);
    }
    if (EXPLICIT_API_BASE) add(EXPLICIT_API_BASE);
    return bases;
  }

  function mediaUrl(value) {
    const raw = String(value || "");
    if (!raw) return "";
    if (/^(https?:|data:|blob:)/i.test(raw)) return raw;
    if (raw.startsWith("/uploads/") || raw.startsWith("uploads/")) {
      const base = ACTIVE_API_BASE || window.location.origin;
      return `${base.replace(/\/$/, "")}/${raw.replace(/^\//, "")}`;
    }
    return raw;
  }
  const imageFallback = "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%20800%20800%22%3E%3Crect%20width%3D%22800%22%20height%3D%22800%22%20fill%3D%22%23f7f5f0%22%2F%3E%3Ctext%20x%3D%2250%25%22%20y%3D%2250%25%22%20dominant-baseline%3D%22middle%22%20text-anchor%3D%22middle%22%20font-family%3D%22Arial%22%20font-size%3D%2236%22%20font-weight%3D%22700%22%20fill%3D%22%230a0a0a%22%3EANIVERSE%3C%2Ftext%3E%3C%2Fsvg%3E";
  // All Categories is admin-controlled. Anime/world collections are managed in
  // Choose Your World / Anime Hero and are not shown here unless an admin
  // explicitly enables “SHOW IN ALL CATEGORIES”.

  let products = [];
  let categories = [];
  let cart = normalizeCart(readJSON("aniverse-cart", []));
  let wishlist = normalizeWishlist(readJSON("aniverse-wishlist", []));
  let appliedDiscount = null;
  let checkoutCustomer = null;
  let customerToken = localStorage.getItem("aniverse-customer-token") || "";
  let customerUser = readJSON("aniverse-customer-user", null);
  let activeCategory = "";
  let searchTimer = null;
  let chromeFrame = null;
  let productsLoaded = false;
  let storeSettings = { shippingFreeThreshold: 999, standardShipping: 79 };
  let heroWorlds = [];

  function readJSON(key, fallback) {
    try {
      const value = localStorage.getItem(key);
      return value ? JSON.parse(value) : fallback;
    } catch {
      return fallback;
    }
  }

  function save() {
    try {
      localStorage.setItem("aniverse-cart", JSON.stringify(cart));
      localStorage.setItem("aniverse-wishlist", JSON.stringify([...wishlist]));
    } catch {
    }
  }

  function normalizeCart(value) {
    if (!Array.isArray(value)) return [];
    return value.map((item) => {
      if (!item || !item.id) return null;
      const qty = Number(item.qty);
      if (!Number.isFinite(qty) || qty <= 0) return null;
      return { id: String(item.id), qty: Math.floor(qty) };
    }).filter(Boolean);
  }

  function normalizeWishlist(value) {
    const source = Array.isArray(value) ? value : [];
    return new Set(source.map((id) => String(id)).filter(Boolean));
  }

  async function api(path, options = {}) {
    const headers = {
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    };
    let lastError = null;
    for (const base of apiBases()) {
      try {
        const response = await fetch(base + path, {
          ...options,
          headers,
          credentials: "include"
        });
        const contentType = response.headers.get("content-type") || "";
        const isJson = contentType.includes("application/json");
        const data = isJson ? await response.json().catch(() => ({})) : {};
        if (response.ok && isJson) {
          ACTIVE_API_BASE = base;
          return data;
        }
        // A frontend SPA/dev server can return a 200 HTML document for an
        // unknown /api route. Never treat that as a successful API response.
        lastError = new Error(
          response.ok && !isJson
            ? `API returned non-JSON content from ${base || window.location.origin}`
            : (data.error || `Request failed (${response.status})`)
        );
        // Try the next configured API base for 404s, HTML fallbacks, and network errors.
        if (response.status !== 404 && isJson) throw lastError;
      } catch (error) {
        lastError = error;
        if (error?.name !== "TypeError" && !/404/.test(String(error?.message || ""))) throw error;
      }
    }
    throw lastError || new Error("API unavailable");
  }

  function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    })[char]);
  }

  function slug(value) {
    return String(value || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  function money(value) {
    const amount = Number(value);
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency: "INR",
      maximumFractionDigits: 0
    }).format(Number.isFinite(amount) ? amount : 0);
  }

  function numericSetting(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : fallback;
  }

  function productImages(product) {
    const values = product.images || (product.image ? [product.image] : []) || [];
    return [...new Set(values.filter((value) => typeof value === "string" && value).map((value) => mediaUrl(value)))];
  }

  function normalizeProduct(product) {
    const categoryValues = [
      ...(Array.isArray(product.categories) ? product.categories : []),
      product.anime,
      product.category,
      product.subcategory,
      ...(Array.isArray(product.tags) ? product.tags : [])
    ];
    const categories = [...new Set(categoryValues.filter((value) => typeof value === "string" && value.trim()).map((value) => value.trim()))];
    const images = productImages(product);
    const legacyId = product.id ? String(product.id) : "";
    return {
      ...product,
      id: String(product._id || product.id || ""),
      legacyId,
      price: numericSetting(product.price ?? product.salePrice ?? product.sellingPrice, 0),
      old: numericSetting(product.old ?? product.compareAtPrice ?? product.compare_at_price, 0),
      stock: Math.max(0, Math.floor(numericSetting(product.stock ?? product.inventory_quantity ?? product.inventoryQuantity ?? product.availableQuantity, 0))),
      active: product.active !== false,
      featured: Boolean(product.featured),
      categories,
      images,
      img: images[0] || imageFallback
    };
  }

  function findProduct(id) {
    const key = String(id || "");
    return products.find((product) => product.id === key || product.legacyId === key) || null;
  }

  function allProductCategories(product) {
    return Array.isArray(product.categories) ? product.categories : [];
  }

  function isPreorder(product) {
    return Boolean(product.isPreorder || product.preorder || String(product.type || "").toLowerCase() === "preorder");
  }

  function activeProducts() {
    return products.filter((product) => product.id && product.active !== false);
  }

  function categoryAliases(category) {
    const key = slug(category);
    const aliases = new Set([key]);
    // Keep the navigation and All Categories directory in sync even when an
    // older product was saved with a slightly different merchandise label.
    const aliasMap = {
      figures: ["figurines"],
      figurines: ["figures"],
      qposket: ["qposket-figures"],
      "premium-figures": ["premium-figure", "premium-figurines"],
      "funko-pop": ["funkopop", "funko"]
    };
    (aliasMap[key] || []).forEach((value) => aliases.add(value));
    return aliases;
  }

  function matchesCategory(product, category) {
    const expected = categoryAliases(category);
    return allProductCategories(product).some((value) => {
      const candidate = slug(value);
      return expected.has(candidate);
    });
  }

  function isBanpresto(product) {
    return allProductCategories(product).some((value) => slug(value).includes("banpresto")) || /banpresto/i.test(String(product.name || ""));
  }

  function sortCatalog(list, mode) {
    const sorted = [...list];
    if (mode === "low") sorted.sort((a, b) => a.price - b.price || a.name.localeCompare(b.name));
    if (mode === "high") sorted.sort((a, b) => b.price - a.price || a.name.localeCompare(b.name));
    if (mode === "new" || mode === "newest") sorted.sort((a, b) => String(b.dateAdded || b.createdAt || "").localeCompare(String(a.dateAdded || a.createdAt || "")) || a.name.localeCompare(b.name));
    if (mode === "bestseller") sorted.sort((a, b) => Number(Boolean(b.featured)) - Number(Boolean(a.featured)) || Number(b.stock > 0) - Number(a.stock > 0) || String(b.dateAdded || b.createdAt || "").localeCompare(String(a.dateAdded || a.createdAt || "")));
    return sorted;
  }

  function demoBanprestoProducts() {
    const base = [
      ["Banpresto Grandista Monkey D. Luffy (Gear 5)", "One Piece", 2499, 3299, "/images/hero/one-piece.jpg", "BESTSELLER"],
      ["Banpresto Grandista Son Goku (Super Saiyan Blue)", "Dragon Ball", 2699, 3499, "/images/hero/dragon-ball.jpg", "NEW"],
      ["Banpresto Vibration Stars Uzumaki Naruto", "Naruto", 2199, 2799, "/images/hero/naruto.jpg", "HOT"],
      ["Banpresto Vibration Stars Tanjiro Kamado", "Demon Slayer", 2299, 2999, "/images/hero/demon-slayer.jpg", "POPULAR"],
      ["Banpresto King of Artist Satoru Gojo", "Jujutsu Kaisen", 2599, 3299, "/images/hero/jujutsu-kaisen.jpg", "NEW"],
      ["Banpresto The Amazing Heroes Izuku Midoriya", "My Hero Academia", 2299, 2999, "/images/hero/my-hero-academia.jpg", "NEW"]
    ];
    return base.map((x, index) => ({
      id: `demo-banpresto-${index + 1}`,
      legacyId: `demo-banpresto-${index + 1}`,
      name: x[0], anime: x[1], categories: ["Banpresto", x[1]], price: x[2], old: x[3],
      stock: 8, active: true, featured: true, badge: x[5], demo: true, images: [x[4]], img: x[4]
    }));
  }

  function render(id, list, emptyMessage = "No products found in this collection.") {
    const element = $(`#${id}`);
    if (!element) return;
    const items = Array.isArray(list) ? list : [];
    element.innerHTML = items.length
      ? items.map(productCard).join("")
      : `<div class="empty-state">${escapeHTML(emptyMessage)}</div>`;
  }

  function productCard(product) {
    const soldOut = product.stock <= 0;
    const image = product.img || imageFallback;
    const badge = isPreorder(product) ? "PRE-ORDER" : (product.badge || "COLLECTIBLE");
    return `<article class="product-card ${soldOut ? "sold-out" : ""} ${product.demo ? "demo-product" : ""}" data-product="${escapeHTML(product.id)}" ${product.demo ? "data-demo-product=\"true\"" : "tabindex=\"0\" role=\"link\""} aria-label="View ${escapeHTML(product.name)}">
      <div class="product-image">
        <span class="badge">${escapeHTML(badge)}</span>
        <button class="wish ${wishlist.has(product.id) ? "saved" : ""}" type="button" data-wish="${escapeHTML(product.id)}" aria-label="${wishlist.has(product.id) ? "Remove from" : "Add to"} wishlist">${wishlist.has(product.id) ? "♥" : "♡"}</button>
        <img src="${escapeHTML(image)}" alt="${escapeHTML(product.name)}" loading="lazy" onerror="this.onerror=null;this.src='${imageFallback}'">
      </div>
      <div class="product-info">
        <div class="product-meta">${escapeHTML((allProductCategories(product)[0] || "ANIVERSE").toUpperCase())}</div>
        <div class="product-name">${escapeHTML(product.name)}</div>
        <div class="price">${money(product.price)} ${product.old && product.old > product.price ? `<span class="old">${money(product.old)}</span>` : ""}</div>
        <button class="add" type="button" data-add="${escapeHTML(product.id)}" ${soldOut ? "disabled" : ""}>${soldOut ? "SOLD OUT" : "ADD TO CART"}</button>
      </div>
    </article>`;
  }

  function renderHome() {
    const all = activeProducts();
    const newArrivals = all.filter((product) => !isPreorder(product)).sort((a, b) => String(b.dateAdded || b.createdAt || "").localeCompare(String(a.dateAdded || a.createdAt || "")) || a.name.localeCompare(b.name));
    const featured = all.filter((product) => product.featured);
    const heroPool = featured.length ? featured : newArrivals;
    let banpresto = all.filter(isBanpresto);
    if (!banpresto.length) banpresto = demoBanprestoProducts();
    render("productGrid", heroPool.slice(0, 6), "No featured figures yet.");
    render("banprestoGrid", banpresto.slice(0, 8), "No Banpresto figures available right now.");
    renderCategoryCards();
    // New Arrivals and Pre-Orders are intentionally catalogue-only and are exposed in the navbar.
    // Anime hero is managed independently through the admin panel.
  }

  function renderNewArrivalsCarousel(list) {
    const track = $("#newArrivalsTrack");
    if (!track) return;
    const items = Array.isArray(list) ? list.slice(0, 12) : [];
    track.innerHTML = items.length
      ? items.map(productCard).join("")
      : '<div class="empty-state">No new arrivals yet.</div>';
  }

  function scrollNewArrivals(direction) {
    const track = $("#newArrivalsTrack");
    if (!track) return;
    const amount = Math.max(280, Math.round(track.clientWidth * 0.72));
    track.scrollBy({ left: direction * amount, behavior: "smooth" });
  }

  function scrollBanpresto(direction) {
    const track = $("#banprestoGrid");
    if (!track) return;
    const first = track.querySelector(".product-card");
    const gap = parseFloat(getComputedStyle(track).gap || "16") || 16;
    const amount = first ? first.getBoundingClientRect().width + gap : Math.max(280, Math.round(track.clientWidth * 0.72));
    track.scrollBy({ left: direction * amount * 2, behavior: "smooth" });
  }

  function scrollProductRail(selector, direction) {
    const track = $(selector);
    if (!track) return;
    const first = track.querySelector(".product-card");
    const gap = parseFloat(getComputedStyle(track).gap || "16") || 16;
    const amount = first ? first.getBoundingClientRect().width + gap : Math.max(280, Math.round(track.clientWidth * 0.72));
    track.scrollBy({ left: direction * amount * 2, behavior: "smooth" });
  }

  function renderCategoryCards() {
    const directory = $("#categoryDirectory");
    if (!directory) return;
    // Only categories explicitly enabled by Admin appear on the All Categories page.
    // This prevents anime/world collections from leaking into this merchandise directory.
    const known = new Map();
    categories.filter((category) => category?.showInDirectory === true).forEach((category) => {
      const name = String(category.name || "").trim();
      if (name && !known.has(slug(name))) known.set(slug(name), category);
    });
    const ordered = [...known.values()];
    directory.innerHTML = ordered.length ? ordered.map((category) => {
      const name = String(category.name || "").trim();
      const image = mediaUrl(category.image || "");
      const visual = image
        ? `<img src="${escapeHTML(image)}" alt="" loading="lazy" onerror="this.onerror=null;this.src='${imageFallback}'">`
        : `<span class="category-letter" aria-hidden="true">${escapeHTML(name.charAt(0).toUpperCase())}</span>`;
      return `<button class="category-chip-card" type="button" data-category="${escapeHTML(name)}" aria-label="Shop ${escapeHTML(name)}">${visual}<span>${escapeHTML(name.toUpperCase())}</span><b aria-hidden="true">→</b></button>`;
    }).join("") : `<div class="empty-state">Categories are loading.</div>`;
  }

  function sanitizeCart() {
    if (!productsLoaded) return;
    let changed = false;
    const next = [];
    cart.forEach((item) => {
      const product = findProduct(item.id);
      if (!product || product.stock <= 0) {
        changed = true;
        return;
      }
      const qty = Math.max(1, Math.min(product.stock, Math.floor(Number(item.qty) || 1)));
      if (qty !== item.qty) changed = true;
      next.push({ id: product.id, qty });
    });
    if (changed) {
      cart = next;
      save();
    }
  }

  function cartTotals() {
    const subtotal = cart.reduce((sum, item) => {
      const product = findProduct(item.id);
      return sum + (product ? product.price * Math.min(item.qty, product.stock) : 0);
    }, 0);
    const discount = Math.min(subtotal, numericSetting(appliedDiscount?.amount, 0));
    const payableBeforeShipping = Math.max(0, subtotal - discount);
    const shipping = payableBeforeShipping === 0 || payableBeforeShipping >= storeSettings.shippingFreeThreshold ? 0 : storeSettings.standardShipping;
    return { subtotal, discount, shipping, payable: payableBeforeShipping + shipping };
  }

  function updateCounts() {
    const cartCount = $("#cartCount");
    const wishCount = $("#wishCount");
    if (cartCount) cartCount.textContent = cart.reduce((sum, item) => sum + Math.max(0, Number(item.qty) || 0), 0);
    if (wishCount) wishCount.textContent = wishlist.size;
  }

  function renderCart() {
    sanitizeCart();
    const element = $("#cartItems");
    let total = 0;
    const rows = cart.map((item) => {
      const product = findProduct(item.id);
      if (!product || product.stock <= 0) return "";
      item.qty = Math.min(item.qty, product.stock);
      total += product.price * item.qty;
      return `<div class="cart-row"><img src="${escapeHTML(product.img || imageFallback)}" alt="${escapeHTML(product.name)}"><div class="cart-row-main"><strong>${escapeHTML(product.name)}</strong><small>${money(product.price)}</small><div class="qty"><button type="button" data-qty="${escapeHTML(product.id)}" data-delta="-1" aria-label="Decrease quantity">−</button><span>${item.qty}</span><button type="button" data-qty="${escapeHTML(product.id)}" data-delta="1" aria-label="Increase quantity">+</button></div></div><button class="remove" type="button" data-remove="${escapeHTML(product.id)}" aria-label="Remove ${escapeHTML(product.name)}">×</button></div>`;
    }).join("");
    if (element) element.innerHTML = rows || '<div class="cart-empty">Your cart is waiting for its next collectible.</div>';
    const totals = cartTotals();
    const subtotal = $("#subtotal");
    const shipping = $("#shipping");
    const cartTotal = $("#cartTotal");
    const shippingNote = $("#shippingNote");
    const checkoutBtn = $("#checkoutBtn");
    if (subtotal) subtotal.textContent = money(totals.subtotal);
    if (shipping) shipping.textContent = money(totals.shipping);
    if (cartTotal) cartTotal.textContent = money(totals.payable);
    if (shippingNote) shippingNote.textContent = `FREE SHIPPING ABOVE ${money(storeSettings.shippingFreeThreshold)}`;
    if (checkoutBtn) checkoutBtn.disabled = cart.length === 0;
    save();
  }

  function renderSearch(value = "") {
    const results = $("#searchResults");
    if (!results) return;
    const term = String(value || "").trim().toLowerCase();
    if (!productsLoaded) {
      results.innerHTML = '<div class="empty-state">Search is loading…</div>';
      return;
    }
    const searchable = (product) => [
      product.name,
      product.description,
      ...allProductCategories(product),
      ...(Array.isArray(product.tags) ? product.tags : []),
      ...(Array.isArray(product.features) ? product.features : [])
    ].join(" ").toLowerCase();
    const list = term
      ? activeProducts().filter((product) => searchable(product).includes(term)).slice(0, 8)
      : activeProducts().slice(0, 8);
    results.innerHTML = list.length
      ? list.map((product) => `<button class="search-result" type="button" data-product="${escapeHTML(product.id)}"><img src="${escapeHTML(product.img || imageFallback)}" alt=""><div><strong>${escapeHTML(product.name)}</strong><span>${money(product.price)}</span></div></button>`).join("")
      : '<div class="empty-state">No matches. Try another anime, character or collectible.</div>';
  }

  const animeThemes = {
    "one-piece": { label: "ONE PIECE", tagline: "SET SAIL • FIND YOUR NEXT TREASURE", accent: "#168cff", deep: "#06111d", glow: "#0077cc", bg: "/images/hero/one-piece.jpg", mark: "☠ ONE PIECE" },
    "naruto": { label: "NARUTO", tagline: "NINJA LEGACY • BELIEVE IT", accent: "#ff7a00", deep: "#160a05", glow: "#d94801", bg: "/images/hero/naruto.jpg", mark: "NARUTO" },
    "dragon-ball": { label: "DRAGON BALL", tagline: "POWER UP • REACH BEYOND LIMITS", accent: "#f2b400", deep: "#0d0b07", glow: "#d58b00", bg: "/images/hero/dragon-ball.jpg", mark: "DRAGON BALL" },
    "jujutsu-kaisen": { label: "JUJUTSU KAISEN", tagline: "CURSED ENERGY • ENTER THE DOMAIN", accent: "#9b5cff", deep: "#0b0712", glow: "#5b21b6", bg: "/images/hero/jujutsu-kaisen.jpg", mark: "呪術廻戦" },
    "demon-slayer": { label: "DEMON SLAYER", tagline: "BREATH • BLADE • DESTINY", accent: "#18b879", deep: "#04120d", glow: "#087f55", bg: "/images/hero/demon-slayer.jpg", mark: "鬼滅の刃" },
    "solo-leveling": { label: "SOLO LEVELING", tagline: "ARISE • BUILD YOUR LEGEND", accent: "#765cff", deep: "#06070e", glow: "#30228a", bg: "/images/hero/solo-leveling.png", mark: "SOLO LEVELING" },
    "attack-on-titan": { label: "ATTACK ON TITAN", tagline: "BEYOND THE WALLS", accent: "#b99b5d", deep: "#0e0d0a", glow: "#5e4b25", bg: "/images/hero/attack-on-titan.jpg", mark: "ATTACK ON TITAN" },
    "bleach": { label: "BLEACH", tagline: "SOULS • SWORDS • DESTINY", accent: "#ff3b30", deep: "#100608", glow: "#8f1020", bg: "/images/hero/bleach.jpg", mark: "BLEACH" },
    "chainsaw-man": { label: "CHAINSAW MAN", tagline: "CHAOS • DEVILS • NO BRAKES", accent: "#ef4444", deep: "#100707", glow: "#a11a1a", bg: "/images/hero/chainsaw-man.jpg", mark: "CHAINSAW MAN" },
    "blue-lock": { label: "BLUE LOCK", tagline: "EGO • STRIKER • VICTORY", accent: "#22a7ff", deep: "#06101b", glow: "#1264a3", bg: "/images/hero/blue-lock.jpg", mark: "BLUE LOCK" },
    "death-note": { label: "DEATH NOTE", tagline: "THE HUMAN WHOSE NAME IS WRITTEN", accent: "#a855f7", deep: "#08060c", glow: "#4c1d95", bg: "/images/hero/death-note.jpg", mark: "DEATH NOTE" },
    "my-hero-academia": { label: "MY HERO ACADEMIA", tagline: "PLUS ULTRA", accent: "#22c55e", deep: "#06100a", glow: "#15803d", bg: "/images/hero/my-hero-academia.jpg", mark: "PLUS ULTRA" },
    "hunter-x-hunter": { label: "HUNTER X HUNTER", tagline: "ADVENTURE • FRIENDSHIP • CHALLENGE", accent: "#facc15", deep: "#111008", glow: "#a16207", bg: "/images/hero/hunter-x-hunter.jpg", mark: "HUNTER × HUNTER" },
    "kaiju-no-8": { label: "KAIJU NO. 8", tagline: "DEFEND THE CITY", accent: "#14b8a6", deep: "#06100f", glow: "#0f766e", bg: "/images/hero/kaiju-no-8.jpg", mark: "KAIJU NO. 8" },
    "dandadan": { label: "DANDADAN", tagline: "ALIENS • SPIRITS • MAYHEM", accent: "#ec4899", deep: "#10070d", glow: "#9d174d", bg: "/images/hero/dandadan.jpg", mark: "DANDADAN" },
    "k-pop-demon-hunters": { label: "K-POP DEMON HUNTERS", tagline: "STAGE • STYLE • HUNT", accent: "#f43f5e", deep: "#10070b", glow: "#9f1239", bg: "/images/hero/k-pop-demon-hunters.jpg", mark: "DEMON HUNTERS" }
  };

  function applyAnimeTheme(category) {
    const shop = $("#shop");
    if (!shop) return;
    const raw = String(category || "").trim();
    const key = slug(raw);
    const theme = animeThemes[key];
    if (theme && raw !== "__all" && !raw.startsWith("__")) {
      shop.dataset.animeTheme = key;
      shop.style.setProperty("--anime-accent", theme.accent);
      shop.style.setProperty("--anime-deep", theme.deep);
      shop.style.setProperty("--anime-glow", theme.glow);
      shop.style.setProperty("--anime-bg", `url("${theme.bg}")`);
      shop.style.setProperty("--anime-mark", `"${theme.mark}"`);
      shop.classList.add("world-themed");
      const sub = $("#animeThemeSubtitle");
      if (sub) sub.innerHTML = `<span>${escapeHTML(theme.label)}</span><small>${escapeHTML(theme.tagline)}</small>`;
      const loader = $("#worldLoader");
      if (loader) {
        loader.querySelector(".world-loader-mark")?.replaceChildren(document.createTextNode(theme.mark));
        loader.querySelector(".world-loader-title")?.replaceChildren(document.createTextNode(`LOADING ${theme.label} WORLD`));
      }
    } else {
      delete shop.dataset.animeTheme;
      shop.style.removeProperty("--anime-accent");
      shop.style.removeProperty("--anime-deep");
      shop.style.removeProperty("--anime-glow");
      shop.style.removeProperty("--anime-bg");
      shop.style.removeProperty("--anime-mark");
      shop.classList.remove("world-themed");
      const sub = $("#animeThemeSubtitle");
      if (sub) sub.innerHTML = "";
    }
  }

  function updateCatalog() {
    const query = $("#shopSearch")?.value.trim().toLowerCase() || "";
    let list = activeProducts();
    let catalogMode = "";
    if (activeCategory === "__wishlist") {
      list = list.filter((product) => wishlist.has(product.id));
    } else if (activeCategory === "__new") {
      catalogMode = "new";
      list = list.filter((product) => !isPreorder(product));
    } else if (activeCategory === "__preorder") {
      catalogMode = "preorder";
      list = list.filter(isPreorder);
    } else if (activeCategory === "__bestseller") {
      catalogMode = "bestseller";
    } else if (activeCategory === "__sale") {
      catalogMode = "sale";
      list = list.filter((product) => product.old > product.price);
    } else if (activeCategory && activeCategory !== "__all") {
      list = list.filter((product) => matchesCategory(product, activeCategory));
    }
    if (query) {
      list = list.filter((product) => [product.name, ...allProductCategories(product), product.description || ""].join(" ").toLowerCase().includes(query));
    }
    const selectedSort = catalogMode === "new" ? "new" : catalogMode === "bestseller" ? "bestseller" : ($("#sort")?.value || "featured");
    list = sortCatalog(list, selectedSort);
    const context = $("#catalogContext");
    if (context) {
      context.innerHTML = activeCategory ? `<span>SHOPPING</span><strong>${escapeHTML(activeCategory === "__wishlist" ? "WISHLIST" : activeCategory)}</strong><button type="button" data-clear-category>VIEW ALL</button>` : "";
    }
    const title = $("#shopTitle");
    if (title) title.textContent = activeCategory === "__wishlist" ? "WISHLIST" : activeCategory === "__new" ? "NEW ARRIVALS" : activeCategory === "__preorder" ? "PRE-ORDERS" : activeCategory === "__bestseller" ? "BEST SELLERS" : activeCategory === "__sale" ? "SALE" : activeCategory && activeCategory !== "__all" ? activeCategory.toUpperCase() : "ALL PRODUCTS";
    render("shopGrid", list, activeCategory ? "No products found in this collection." : "No products found.");
  }

  function renderDetail(product) {
    const images = productImages(product);
    const mainImage = images[0] || imageFallback;
    const related = activeProducts().filter((item) => item.id !== product.id && allProductCategories(item).some((category) => allProductCategories(product).includes(category))).slice(0, 4);
    const soldOut = product.stock <= 0;
    $("#productDetail").innerHTML = `<div class="detail-grid"><div class="detail-gallery"><div class="detail-main"><img id="detailMainImage" src="${escapeHTML(mainImage)}" alt="${escapeHTML(product.name)}"></div><div class="detail-thumbs">${images.length ? images.map((image, index) => `<button class="detail-thumb ${index === 0 ? "active" : ""}" type="button" data-detail-image="${escapeHTML(image)}" aria-label="View image ${index + 1}"><img src="${escapeHTML(image)}" alt="${escapeHTML(product.name)} image ${index + 1}" loading="lazy"></button>`).join("") : ""}</div></div><div class="detail-copy"><p class="eyebrow">${escapeHTML(isPreorder(product) ? "PRE-ORDER" : product.badge || "COLLECTIBLE")}</p><h2>${escapeHTML(product.name)}</h2><div class="detail-price">${money(product.price)} ${product.old && product.old > product.price ? `<span class="old">${money(product.old)}</span>` : ""}</div><div class="detail-stock ${soldOut ? "out" : ""}">${soldOut ? "Currently sold out" : `${product.stock} available`}</div><div class="detail-cats">${allProductCategories(product).map((category) => `<button type="button" data-detail-category="${escapeHTML(category)}">${escapeHTML(category)}</button>`).join("")}</div><p class="detail-description">${escapeHTML(product.description || "A carefully selected Aniverse collectible made for fans and collectors.")}</p><div class="detail-actions"><button class="btn btn-primary" type="button" data-add="${escapeHTML(product.id)}" ${soldOut ? "disabled" : ""}>${soldOut ? "SOLD OUT" : "ADD TO CART →"}</button><button class="detail-wishlist" type="button" data-wish="${escapeHTML(product.id)}">${wishlist.has(product.id) ? "♥ SAVED" : "♡ SAVE"}</button></div></div></div>${related.length ? `<div class="related-products"><div class="section-head"><div><p class="eyebrow">YOU MAY ALSO LIKE</p><h3>MORE FROM THE UNIVERSE</h3></div></div><div class="product-grid">${related.map(productCard).join("")}</div></div>` : ""}`;
    $$("#productDetail img").forEach((image) => {
      image.addEventListener("error", () => {
        if (image.getAttribute("src") !== imageFallback) image.setAttribute("src", imageFallback);
      }, { once: true });
    });
  }

  function customerHeaders() { return customerToken ? { Authorization: `Bearer ${customerToken}` } : {}; }
  function customerSaveSession(token, user) { customerToken = token || ""; customerUser = user || null; if (customerToken) localStorage.setItem("aniverse-customer-token", customerToken); else localStorage.removeItem("aniverse-customer-token"); if (customerUser) localStorage.setItem("aniverse-customer-user", JSON.stringify(customerUser)); else localStorage.removeItem("aniverse-customer-user"); }
  async function loadCustomerSession() { if (!customerToken) return null; try { const user = await api("/api/account/me", { headers: customerHeaders() }); customerUser = user; localStorage.setItem("aniverse-customer-user", JSON.stringify(user)); return user; } catch { customerSaveSession("", null); return null; } }
  async function renderAccount() {
    const box = $("#accountContent"); if (!box) return;
    const user = await loadCustomerSession();
    if (!user) {
      box.innerHTML = `<div class="account-kicker">ANIVERSE ACCOUNT</div><h2>WELCOME BACK.</h2><p class="account-copy">Sign in to keep your details ready and view your Aniverse orders.</p><div class="account-tabs"><button class="active" data-account-tab="login">SIGN IN</button><button data-account-tab="register">CREATE ACCOUNT</button></div><form id="accountLoginForm" class="account-form"><label>Email<input name="email" type="email" autocomplete="email" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button class="btn btn-primary full" type="submit">SIGN IN →</button><div class="account-status" id="accountStatus"></div></form><form id="accountRegisterForm" class="account-form" hidden><label>Name<input name="name" autocomplete="name" required></label><label>Email<input name="email" type="email" autocomplete="email" required></label><label>Phone <span class="muted">(optional)</span><input name="phone" autocomplete="tel" inputmode="tel"></label><label>Password<input name="password" type="password" minlength="8" autocomplete="new-password" required></label><button class="btn btn-primary full" type="submit">CREATE ACCOUNT →</button><div class="account-status" id="accountRegisterStatus"></div></form><p class="account-footnote">Forgot your password? Contact Aniverse support and we’ll help you recover the account.</p>`;
      $$("[data-account-tab]").forEach(btn => btn.onclick=()=>{ $$("[data-account-tab]").forEach(x=>x.classList.toggle("active",x===btn)); $("#accountLoginForm").hidden=btn.dataset.accountTab!=="login"; $("#accountRegisterForm").hidden=btn.dataset.accountTab!=="register"; });
      $("#accountLoginForm")?.addEventListener("submit", async e=>{e.preventDefault();const f=new FormData(e.target);const status=$("#accountStatus");const b=e.target.querySelector("button[type=submit]");b.disabled=true;status.textContent="Signing in…";try{const d=await api("/api/account/login",{method:"POST",body:JSON.stringify({email:f.get("email"),password:f.get("password")})});customerSaveSession(d.token,d.user);showToast("Welcome back.","success");await renderAccount();}catch(err){status.textContent=err.message;}finally{b.disabled=false;}});
      $("#accountRegisterForm")?.addEventListener("submit", async e=>{e.preventDefault();const f=new FormData(e.target);const status=$("#accountRegisterStatus");const b=e.target.querySelector("button[type=submit]");b.disabled=true;status.textContent="Creating account…";try{const d=await api("/api/account/register",{method:"POST",body:JSON.stringify({name:f.get("name"),email:f.get("email"),phone:f.get("phone"),password:f.get("password")})});customerSaveSession(d.token,d.user);showToast("Account created.","success");await renderAccount();}catch(err){status.textContent=err.message;}finally{b.disabled=false;}});
    } else {
      let orders=[]; try { orders=await api("/api/account/orders",{headers:customerHeaders()}); } catch {}
      box.innerHTML = `<div class="account-kicker">MY ANIVERSE</div><div class="account-head"><div><h2>${escapeHTML(user.name||"COLLECTOR")}</h2><p>${escapeHTML(user.email||"")}${user.phone?` · ${escapeHTML(user.phone)}`:""}</p></div><button class="account-logout" id="accountLogout">SIGN OUT</button></div><div class="account-section"><div class="account-section-head"><h3>ORDER HISTORY</h3><span>${orders.length} order${orders.length===1?"":"s"}</span></div><div class="account-orders">${orders.length?orders.map(o=>`<div class="account-order"><div><strong>${escapeHTML(o.orderNumber||String(o._id||"").slice(-8))}</strong><small>${new Date(o.createdAt||Date.now()).toLocaleDateString("en-IN")} · ${escapeHTML(o.status||o.paymentStatus||"pending")}</small></div><strong>${money(o.total)}</strong></div>`).join(""):'<div class="empty-state">Your orders will appear here after your first purchase.</div>'}</div></div><div class="account-section"><div class="account-section-head"><h3>ACCOUNT DETAILS</h3></div><form id="accountProfileForm" class="account-form"><label>Name<input name="name" value="${escapeHTML(user.name||"")}" required></label><label>Phone<input name="phone" value="${escapeHTML(user.phone||"")}" inputmode="tel"></label><button class="btn btn-primary" type="submit">SAVE DETAILS</button><div class="account-status" id="profileStatus"></div></form></div>`;
      $("#accountLogout")?.addEventListener("click",()=>{customerSaveSession("",null);renderAccount();showToast("Signed out.");});
      $("#accountProfileForm")?.addEventListener("submit",async e=>{e.preventDefault();const f=new FormData(e.target);try{const updated=await api("/api/account/me",{method:"PATCH",headers:customerHeaders(),body:JSON.stringify({name:f.get("name"),phone:f.get("phone")})});customerUser=updated;localStorage.setItem("aniverse-customer-user",JSON.stringify(updated));$("#profileStatus").textContent="Saved.";showToast("Account updated.","success");}catch(err){$("#profileStatus").textContent=err.message;}});
    }
  }
  function openAccount() { closeAll("account"); const modal=$("#accountModal"); if(!modal)return; modal.classList.add("open"); modal.setAttribute("aria-hidden","false"); renderAccount(); syncBodyLock(); requestAnimationFrame(()=>$("#accountClose")?.focus({preventScroll:true})); }
  function closeAccount() { const modal=$("#accountModal"); if(!modal)return; modal.classList.remove("open"); modal.setAttribute("aria-hidden","true"); syncBodyLock(); }

  function setExpanded(selector, value) {
    const element = $(selector);
    if (element) element.setAttribute("aria-expanded", String(value));
  }

  function closeSurface(name) {
    const selectors = {
      search: "#searchPanel",
      cart: "#cartDrawer",
      shop: "#shop",
      product: "#productModal",
      checkout: "#checkoutModal",
      account: "#accountModal",
      mobile: "#mobileMenu",
      categories: "#categoriesPage"
    };
    const element = $(selectors[name]);
    if (!element) return;
    element.classList.remove("open");
    element.setAttribute("aria-hidden", "true");
    if (name === "search") setExpanded("#searchBtn", false);
    if (name === "cart") {
      setExpanded("#cartBtn", false);
      $("#overlay")?.classList.remove("active");
      $("#overlay")?.setAttribute("aria-hidden", "true");
    }
    if (name === "mobile") setExpanded("#menuBtn", false);
    if (name === "account") setExpanded("#accountBtn", false);
    if (name === "categories") {
      // Categories is a standalone browsing surface; keep the current catalogue state intact.
    }
    if (name === "wishlist") setExpanded("#wishlistBtn", false);
    if (name === "shop") activeCategory = "";
    syncBodyLock();
  }

  function closeAll(except = "") {
    Object.keys({ search: 1, cart: 1, shop: 1, product: 1, checkout: 1, account: 1, mobile: 1, categories: 1, wishlist: 1 }).forEach((name) => {
      if (name !== except) closeSurface(name);
    });
  }

  function syncBodyLock() {
    const open = ["#searchPanel.open", "#cartDrawer.open", "#shop.open", "#productModal.open", "#checkoutModal.open", "#accountModal.open", "#mobileMenu.open", "#categoriesPage.open"].some((selector) => !!$(selector));
    document.body.classList.toggle("modal-open", open);
    document.body.classList.toggle("drawer-open", !!$("#cartDrawer.open"));
  }

  function updateChromeOffset() {
    chromeFrame = null;
    const header = $("#header");
    if (!header) return;
    const rect = header.getBoundingClientRect();
    const top = Math.max(0, Math.round(rect.bottom));
    const height = Math.max(1, Math.round(rect.height || top));
    document.documentElement.style.setProperty("--chrome-top", `${top}px`);
    document.documentElement.style.setProperty("--header-height", `${height}px`);
  }

  function scheduleChromeOffset() {
    if (chromeFrame) return;
    chromeFrame = requestAnimationFrame(updateChromeOffset);
  }

  function openSearch() {
    // Search is an overlay on the current browsing surface. Never close the shop or product modal.
    closeSurface("mobile");
    const panel = $("#searchPanel");
    if (!panel) return;
    setExpanded("#searchBtn", true);
    updateChromeOffset();
    panel.classList.add("open");
    panel.setAttribute("aria-hidden", "false");
    syncBodyLock();
    requestAnimationFrame(() => {
      updateChromeOffset();
      const input = $("#searchInput");
      input?.focus({ preventScroll: true });
      input?.select();
    });
    renderSearch($("#searchInput")?.value || "");
  }

  function closeSearch() {
    clearTimeout(searchTimer);
    closeSurface("search");
  }

  function openCart() {
    // Keep the current browsing surface underneath the drawer. Closing the cart
    // must return the customer to the exact page/context they were shopping in.
    closeSurface("search");
    closeSurface("mobile");
    const drawer = $("#cartDrawer");
    if (!drawer) return;
    renderCart();
    setExpanded("#cartBtn", true);
    drawer.classList.add("open");
    drawer.setAttribute("aria-hidden", "false");
    $("#overlay")?.classList.add("active");
    $("#overlay")?.setAttribute("aria-hidden", "false");
    syncBodyLock();
    requestAnimationFrame(() => {
      updateChromeOffset();
      $("#closeCart")?.focus({ preventScroll: true });
    });
  }

  function closeCart() {
    closeSurface("cart");
  }

  function openShop(category = "") {
    closeAll("shop");
    activeCategory = String(category || "");
    const section = $("#shop");
    if (!section) return;
    applyAnimeTheme(activeCategory);
    const search = $("#shopSearch");
    const sort = $("#sort");
    if (search) search.value = "";
    if (sort) sort.value = "featured";
    setExpanded("#wishlistBtn", activeCategory === "__wishlist");
    section.classList.add("open");
    section.setAttribute("aria-hidden", "false");
    section.scrollTop = 0;
    syncBodyLock();
    if (animeThemes[slug(activeCategory || "")]) {
      const loader = $("#worldLoader");
      loader?.classList.add("show");
      updateCatalog();
      window.setTimeout(() => loader?.classList.remove("show"), 480);
    } else {
      updateCatalog();
    }
    requestAnimationFrame(() => {
      updateChromeOffset();
      $("#closeShop")?.focus({ preventScroll: true });
    });
  }

  function closeShop() {
    closeSurface("shop");
  }

  function openCategories() {
    closeAll("categories");
    closeSurface("mobile");
    renderCategoryCards();
    const page = $("#categoriesPage");
    if (!page) return;
    page.classList.add("open");
    page.setAttribute("aria-hidden", "false");
    page.scrollTop = 0;
    syncBodyLock();
    requestAnimationFrame(() => {
      updateChromeOffset();
      $("#closeCategories")?.focus({ preventScroll: true });
    });
  }

  function closeCategories() {
    closeSurface("categories");
  }

  function openProduct(id) {
    const product = findProduct(id);
    if (!product) {
      showToast("This product is no longer available.");
      return;
    }
    closeSurface("search");
    closeSurface("mobile");
    // Keep the originating catalogue/cart surface mounted underneath the product modal.
    renderDetail(product);
    const modal = $("#productModal");
    if (!modal) return;
    modal.classList.add("open");
    modal.setAttribute("aria-hidden", "false");
    syncBodyLock();
    requestAnimationFrame(() => {
      updateChromeOffset();
      $("#productClose")?.focus({ preventScroll: true });
    });
  }

  function closeProduct() {
    closeSurface("product");
  }

  function setCheckoutStep(step) {
    const details = $("#checkoutDetailsStep");
    const review = $("#checkoutReviewStep");
    const detailsStep = $("#checkoutStepDetails");
    const reviewStep = $("#checkoutStepReview");
    const isReview = step === "review";
    if (details) { details.hidden = isReview; details.style.display = isReview ? "none" : "block"; }
    if (review) { review.hidden = !isReview; review.style.display = isReview ? "block" : "none"; }
    detailsStep?.classList.toggle("active", !isReview);
    reviewStep?.classList.toggle("active", isReview);
    if (isReview) renderOrderReview();
  }

  function openCheckout() {
    if (!cart.length) {
      showToast("Your cart is empty.");
      return;
    }
    closeAll("checkout");
    renderCart();
    checkoutCustomer = null;
    appliedDiscount = null;
    const code = $("#reviewDiscountCode");
    if (code) code.value = "";
    const status = $("#checkoutStatus");
    const reviewStatus = $("#reviewPaymentStatus");
    if (status) status.textContent = "";
    if (reviewStatus) reviewStatus.textContent = "";
    setCheckoutStep("details");
    const modal = $("#checkoutModal");
    if (modal) {
      modal.classList.add("open");
      modal.setAttribute("aria-hidden", "false");
    }
    syncBodyLock();
    requestAnimationFrame(() => {
      updateChromeOffset();
      $("#checkoutForm input")?.focus({ preventScroll: true });
    });
  }

  function closeCheckout() {
    closeSurface("checkout");
  }

  function openMobileMenu() {
    closeAll("mobile");
    const menu = $("#mobileMenu");
    if (!menu) return;
    setExpanded("#menuBtn", true);
    menu.classList.add("open");
    menu.setAttribute("aria-hidden", "false");
    syncBodyLock();
    requestAnimationFrame(() => {
      updateChromeOffset();
      $("#closeMenu")?.focus({ preventScroll: true });
    });
  }

  function closeMobileMenu() {
    closeSurface("mobile");
  }

  function toggleMobileMenu() {
    $("#mobileMenu")?.classList.contains("open") ? closeMobileMenu() : openMobileMenu();
  }

  function showToast(message, type = "") {
    const toast = $("#toast");
    if (!toast) return;
    toast.textContent = message;
    toast.className = `toast show ${type}`.trim();
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => toast.classList.remove("show"), 3200);
  }

  function add(id) {
    const product = findProduct(id);
    if (!product || product.stock <= 0) {
      showToast("This product is unavailable.");
      return;
    }
    const existing = cart.find((item) => item.id === product.id);
    if (existing) existing.qty = Math.min(existing.qty + 1, product.stock);
    else cart.push({ id: product.id, qty: 1 });
    appliedDiscount = null;
    save();
    updateCounts();
    renderCart();
    openCart();
    showToast(`${product.name} added to cart.`);
  }

  function changeQty(id, delta) {
    const item = cart.find((entry) => entry.id === String(id));
    const product = findProduct(id);
    if (!item || !product) return;
    item.qty = Math.max(0, Math.min(product.stock, item.qty + delta));
    if (!item.qty) cart = cart.filter((entry) => entry !== item);
    appliedDiscount = null;
    save();
    updateCounts();
    renderCart();
  }

  function removeItem(id) {
    cart = cart.filter((item) => item.id !== String(id));
    appliedDiscount = null;
    save();
    updateCounts();
    renderCart();
  }

  function toggleWishlist(id) {
    const key = String(id);
    if (wishlist.has(key)) wishlist.delete(key);
    else wishlist.add(key);
    save();
    updateCounts();
    renderHome();
    if (activeCategory) updateCatalog();
    showToast(wishlist.has(key) ? "Saved to wishlist." : "Removed from wishlist.");
  }

  async function validateAndApplyDiscount(inputSelector, statusSelector) {
    const code = String($(inputSelector)?.value || "").trim();
    const status = $(statusSelector);
    if (!code) {
      appliedDiscount = null;
      if (status) status.textContent = "";
      renderOrderReview();
      return false;
    }
    if (status) status.textContent = "Checking code…";
    try {
      const subtotal = cart.reduce((sum, item) => {
        const product = findProduct(item.id);
        return sum + (product ? product.price * item.qty : 0);
      }, 0);
      const discount = await api("/api/discounts/validate", {
        method: "POST",
        body: JSON.stringify({ code, subtotal })
      });
      appliedDiscount = { code: String(discount.code || code), amount: numericSetting(discount.amount, 0) };
      if ($(inputSelector)) $(inputSelector).value = appliedDiscount.code;
      if (status) status.textContent = `${appliedDiscount.code} applied — saving ${money(appliedDiscount.amount)}`;
      renderOrderReview();
      return true;
    } catch (error) {
      appliedDiscount = null;
      if (status) status.textContent = error.message;
      renderOrderReview();
      return false;
    }
  }

  function renderOrderReview() {
    const customerEl = $("#reviewCustomer");
    const itemsEl = $("#reviewItems");
    const totals = cartTotals();
    if (customerEl && checkoutCustomer) {
      const address = checkoutCustomer.address || {};
      customerEl.innerHTML = `<div class="review-card"><div><span>DELIVER TO</span><strong>${escapeHTML(checkoutCustomer.name)}</strong><small>${escapeHTML(checkoutCustomer.email)} · ${escapeHTML(checkoutCustomer.phone)}</small><small>${escapeHTML(address.line1 || "")} ${address.city ? `, ${escapeHTML(address.city)}` : ""}</small></div><button type="button" class="review-edit" id="reviewEditDetails">EDIT</button></div>`;
    }
    if (itemsEl) {
      itemsEl.innerHTML = cart.map(item => {
        const product = findProduct(item.id);
        if (!product) return "";
        return `<div class="review-item"><img src="${escapeHTML(product.img || imageFallback)}" alt="${escapeHTML(product.name)}"><div><strong>${escapeHTML(product.name)}</strong><small>Qty ${item.qty}</small></div><b>${money(product.price * item.qty)}</b></div>`;
      }).join("");
    }
    const subtotal = $("#reviewSubtotal");
    const discount = $("#reviewDiscount");
    const discountLine = $("#reviewDiscountLine");
    const codeLabel = $("#reviewDiscountCodeLabel");
    const shipping = $("#reviewShipping");
    const total = $("#reviewTotal");
    if (subtotal) subtotal.textContent = money(totals.subtotal);
    if (discount) discount.textContent = `−${money(totals.discount)}`;
    if (discountLine) discountLine.hidden = totals.discount <= 0;
    if (codeLabel) codeLabel.textContent = appliedDiscount?.code ? `(${appliedDiscount.code})` : "";
    if (shipping) shipping.textContent = totals.shipping ? money(totals.shipping) : "FREE";
    if (total) total.textContent = money(totals.payable);
  }

  async function proceedToReview(event) {
    event.preventDefault();
    if (!cart.length) { showToast("Your cart is empty."); return; }
    const form = event.target;
    const customer = {
      name: String(form.elements.name?.value || "").trim(),
      email: String(form.elements.email?.value || "").trim(),
      phone: String(form.elements.phone?.value || "").trim(),
      address: {
        line1: String(form.elements.address?.value || "").trim(),
        city: String(form.elements.city?.value || "").trim()
      }
    };
    if (!customer.name || !customer.email || !customer.phone) {
      if (!form.reportValidity()) return;
      const status = $("#checkoutStatus");
      if (status) status.textContent = "Please complete your contact details.";
      return;
    }
    checkoutCustomer = customer;
    const status = $("#checkoutStatus");
    if (status) status.textContent = "";
    setCheckoutStep("review");
  }

  async function startRazorpayPayment() {
    if (!cart.length || !checkoutCustomer) {
      setCheckoutStep("details");
      return;
    }
    const status = $("#reviewPaymentStatus");
    const button = $("#payNowBtn");
    if (button) button.disabled = true;
    if (status) status.textContent = "Creating secure payment session…";
    try {
      const data = await api("/api/checkout/create-order", {
        method: "POST",
        headers: customerHeaders(),
        body: JSON.stringify({
          customer: checkoutCustomer,
          discountCode: String(appliedDiscount?.code || "").trim(),
          items: cart.map((item) => ({ productId: item.id, qty: item.qty }))
        })
      });
      if (!window.Razorpay) throw new Error("Razorpay Checkout could not load. Please refresh the page.");
      const razorpay = new window.Razorpay({
        key: data.keyId,
        amount: data.amount,
        currency: data.currency,
        name: "Aniverse",
        description: "Anime collectibles",
        order_id: data.razorpayOrderId,
        prefill: { name: checkoutCustomer.name, email: checkoutCustomer.email, contact: checkoutCustomer.phone },
        theme: { color: "#FF6500" },
        modal: {
          ondismiss: () => {
            if (status) status.textContent = "Payment window closed. Your order review is still saved.";
            if (button) button.disabled = false;
          }
        }
      });
      razorpay.on("payment.failed", (response) => {
        if (status) status.textContent = response.error?.description || "Payment failed. Please try again.";
        if (button) button.disabled = false;
      });
      razorpay.on("payment.success", async (response) => {
        if (status) status.textContent = "Verifying payment…";
        try {
          const verified = await api("/api/checkout/verify", { method: "POST", body: JSON.stringify(response) });
          cart = [];
          appliedDiscount = null;
          checkoutCustomer = null;
          save();
          updateCounts();
          renderCart();
          closeCheckout();
          closeCart();
          showToast(`Order ${verified.order?.orderNumber || data.orderNumber} confirmed. Thank you!`, "success");
          await Promise.all([loadProducts(), loadCategories()]);
        } catch (error) {
          if (status) status.textContent = error.message;
          if (button) button.disabled = false;
        }
      });
      razorpay.open();
    } catch (error) {
      if (status) status.textContent = error.message;
      if (button) button.disabled = false;
    }
  }

  function handleAnchor(target) {
    if (target === "#shop") {
      openShop("");
      return;
    }
    if (target === "#categories") {
      openCategories();
      return;
    }
    closeAll();
    if (target === "#home") {
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    const element = $(target);
    if (element) element.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function bindEvents() {
    document.addEventListener("click", (event) => {
      const searchResult = event.target.closest(".search-result[data-product]");
      if (searchResult) {
        event.preventDefault();
        closeSearch();
        openProduct(searchResult.dataset.product);
        return;
      }
      const detailImage = event.target.closest("[data-detail-image]");
      if (detailImage) {
        const main = $("#detailMainImage");
        if (main) main.src = detailImage.dataset.detailImage;
        $$(".detail-thumb").forEach((thumb) => thumb.classList.toggle("active", thumb === detailImage));
        return;
      }
      const detailCategory = event.target.closest("[data-detail-category]");
      if (detailCategory) {
        closeProduct();
        openShop(detailCategory.dataset.detailCategory);
        return;
      }
      if (event.target.closest("[data-clear-category]")) {
        activeCategory = "";
        applyAnimeTheme("");
        updateCatalog();
        return;
      }
      const anime = event.target.closest("[data-anime]");
      if (anime) {
        event.preventDefault();
        openShop(anime.dataset.anime);
        return;
      }
      const catalogMode = event.target.closest("[data-catalog-mode]");
      if (catalogMode) {
        event.preventDefault();
        const mode = catalogMode.dataset.catalogMode;
        openShop(mode === "new" ? "__new" : mode === "preorder" ? "__preorder" : mode === "bestseller" ? "__bestseller" : mode === "sale" ? "__sale" : "");
        return;
      }
      const openCategoriesButton = event.target.closest("[data-open-categories]");
      if (openCategoriesButton) {
        event.preventDefault();
        openCategories();
        return;
      }
      const category = event.target.closest("[data-category]");
      if (category) {
        openShop(category.dataset.category === "__all" ? "" : category.dataset.category);
        return;
      }
      const wish = event.target.closest("[data-wish]");
      if (wish) {
        event.stopPropagation();
        toggleWishlist(wish.dataset.wish);
        return;
      }
      const qty = event.target.closest("[data-qty]");
      if (qty) {
        changeQty(qty.dataset.qty, Number(qty.dataset.delta));
        return;
      }
      const remove = event.target.closest("[data-remove]");
      if (remove) {
        removeItem(remove.dataset.remove);
        return;
      }
      const addItem = event.target.closest("[data-add]");
      if (addItem) {
        event.stopPropagation();
        add(addItem.dataset.add);
        return;
      }
      const card = event.target.closest("[data-product]");
      if (card && !card.dataset.demoProduct && !event.target.closest("button, a, input, select, textarea, summary")) {
        openProduct(card.dataset.product);
      }
      const panel = $("#searchPanel");
      const searchButton = $("#searchBtn");
      if (panel?.classList.contains("open") && !panel.contains(event.target) && !searchButton?.contains(event.target)) closeSearch();
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeAll();
        return;
      }
      if ((event.key === "Enter" || event.key === " ") && event.target.matches("[data-product]") && !event.target.dataset.demoProduct) {
        event.preventDefault();
        openProduct(event.target.dataset.product);
      }
    });

    $("#productClose")?.addEventListener("click", closeProduct);
    $("#productBackdrop")?.addEventListener("click", closeProduct);
    $("#closeShop")?.addEventListener("click", closeShop);
    $("#cartBtn")?.addEventListener("click", openCart);
    $("#closeCart")?.addEventListener("click", closeCart);
    $("#overlay")?.addEventListener("click", closeCart);
    $("#checkoutBtn")?.addEventListener("click", openCheckout);
    $("#accountBtn")?.addEventListener("click", openAccount);
    $("#accountClose")?.addEventListener("click", closeAccount);
    $("#accountBackdrop")?.addEventListener("click", closeAccount);
    $("#checkoutClose")?.addEventListener("click", closeCheckout);
    $("#checkoutBackdrop")?.addEventListener("click", closeCheckout);
    $("#checkoutForm")?.addEventListener("submit", proceedToReview);
    $("#applyReviewDiscount")?.addEventListener("click", () => validateAndApplyDiscount("#reviewDiscountCode", "#reviewDiscountStatus"));
    $("#payNowBtn")?.addEventListener("click", startRazorpayPayment);
    $("#backToDetails")?.addEventListener("click", () => setCheckoutStep("details"));
    $("#checkoutReviewStep")?.addEventListener("click", (event) => {
      if (event.target.closest("#reviewEditDetails")) setCheckoutStep("details");
    });
    $("#wishlistBtn")?.addEventListener("click", () => openShop("__wishlist"));
    $("#searchBtn")?.addEventListener("click", () => $("#searchPanel")?.classList.contains("open") ? closeSearch() : openSearch());
    $("#catalogSearchBtn")?.addEventListener("click", () => { const input = $("#shopSearch"); if (!input) return; input.hidden = false; input.focus({ preventScroll: true }); input.select(); });
    $("#animeNext")?.addEventListener("click", () => $("#animeGrid")?.scrollBy({ left: 420, behavior: "smooth" }));
    $("#newArrivalsNext")?.addEventListener("click", () => scrollNewArrivals(1));
    $("#newArrivalsPrev")?.addEventListener("click", () => scrollNewArrivals(-1));
    $("#featuredNext")?.addEventListener("click", () => scrollProductRail("#productGrid", 1));
    $("#featuredPrev")?.addEventListener("click", () => scrollProductRail("#productGrid", -1));
    $("#banprestoNext")?.addEventListener("click", () => scrollBanpresto(1));
    $("#banprestoPrev")?.addEventListener("click", () => scrollBanpresto(-1));
    $("#preordersNext")?.addEventListener("click", () => scrollProductRail("#preorderGrid", 1));
    $("#preordersPrev")?.addEventListener("click", () => scrollProductRail("#preorderGrid", -1));
    $(".nav-dropdown-trigger")?.addEventListener("click", (event) => { const trigger = event.currentTarget; const dropdown = trigger.closest(".nav-dropdown"); const open = dropdown?.classList.toggle("open"); trigger.setAttribute("aria-expanded", String(Boolean(open))); });
    document.addEventListener("click", (event) => { if (!event.target.closest(".nav-dropdown")) $$(".nav-dropdown.open").forEach((item) => { item.classList.remove("open"); item.querySelector(".nav-dropdown-trigger")?.setAttribute("aria-expanded", "false"); }); });
    $("#closeSearch")?.addEventListener("click", closeSearch);
    $("#closeCategories")?.addEventListener("click", closeCategories);
    $("#searchInput")?.addEventListener("input", (event) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => renderSearch(event.target.value), 120);
    });
    $("#shopSearch")?.addEventListener("input", updateCatalog);
    $("#sort")?.addEventListener("change", updateCatalog);
    $("#checkoutModal")?.addEventListener("keydown", (event) => { if (event.key === "Escape") closeCheckout(); });
    $("#productModal")?.addEventListener("keydown", (event) => { if (event.key === "Escape") closeProduct(); });
    $("#menuBtn")?.addEventListener("click", toggleMobileMenu);
    $("#closeMenu")?.addEventListener("click", closeMobileMenu);
    $("#newsletterForm")?.addEventListener("submit", (event) => {
      event.preventDefault();
      event.target.innerHTML = '<strong class="newsletter-success">YOU’RE IN. WATCH THE NEXT DROP. ✦</strong>';
    });
    document.addEventListener("click", (event) => {
      const link = event.target.closest('a[href^="#"]');
      if (!link || event.defaultPrevented) return;
      event.preventDefault();
      handleAnchor(link.getAttribute("href"));
    });
    window.addEventListener("resize", scheduleChromeOffset, { passive: true });
    window.addEventListener("scroll", scheduleChromeOffset, { passive: true });
    window.addEventListener("scroll", () => $("#header")?.classList.toggle("scrolled", window.scrollY > 20), { passive: true });
    window.addEventListener("hashchange", () => {
      if (window.location.hash === "#shop") openShop("");
      else if (window.location.hash === "#categories") openCategories();
    });
  }

  async function loadProducts() {
    try {
      const settings = await api("/api/store/settings");
      storeSettings = {
        shippingFreeThreshold: numericSetting(settings.shippingFreeThreshold, storeSettings.shippingFreeThreshold),
        standardShipping: numericSetting(settings.standardShipping, storeSettings.standardShipping)
      };
    } catch {
    }
    try {
      // Probe each backend explicitly. This is important on local setups where
      // an older API may return HTTP 200 + [] while the current API has the real
      // inventory. The generic api() helper intentionally hides base selection,
      // so the catalogue loader uses a direct, strict probe here.
      let source = [];
      let selectedBase = null;
      let lastProductError = null;
      const bases = apiBases();
      for (let i = 0; i < bases.length; i += 1) {
        const base = bases[i];
        try {
          const url = `${base}/api/products?limit=2000&__aniverse_probe=${Date.now()}`;
          const response = await fetch(url, {
            headers: { Accept: "application/json", "X-Aniverse-API-Probe": "products" },
            credentials: "include",
            cache: "no-store"
          });
          const contentType = response.headers.get("content-type") || "";
          if (!response.ok || !contentType.includes("application/json")) {
            throw new Error(`Product API unavailable at ${base || window.location.origin} (${response.status})`);
          }
          const payload = await response.json();
          const candidate = Array.isArray(payload) ? payload : (Array.isArray(payload?.products) ? payload.products : (Array.isArray(payload?.data) ? payload.data : []));
          // A non-empty response wins immediately. If all sources are empty,
          // retain the last valid JSON source so a genuinely empty catalogue is
          // represented correctly rather than shown as a request failure.
          if (candidate.length > 0 || i === bases.length - 1) {
            source = candidate;
            selectedBase = base;
            break;
          }
        } catch (error) {
          lastProductError = error;
        }
      }
      if (selectedBase === null && lastProductError) throw lastProductError;
      ACTIVE_API_BASE = selectedBase ?? ACTIVE_API_BASE;
      products = source.map(normalizeProduct).filter((product) => product.id);
      productsLoaded = true;
      sanitizeCart();
      renderHome();
      renderCart();
      updateCounts();
      if (activeCategory) updateCatalog();
      const requestedProduct = new URLSearchParams(window.location.search).get("product");
      if (requestedProduct && productsLoaded) window.setTimeout(() => openProduct(requestedProduct), 0);
      if ($("#searchPanel")?.classList.contains("open")) renderSearch($("#searchInput")?.value || "");
    } catch (error) {
      console.error(error);
      products = [];
      productsLoaded = false;
      ["productGrid", "preorderGrid", "shopGrid"].forEach((id) => {
        const element = $(`#${id}`);
        if (element) element.innerHTML = '<div class="empty-state error">We could not load the catalogue. Please refresh in a moment.</div>';
      });
      renderCart();
      updateCounts();
    }
  }

  async function loadCategories() {
    try {
      const response = await api("/api/categories");
      categories = Array.isArray(response) ? response : (Array.isArray(response.categories) ? response.categories : []);
    } catch (error) {
      console.error(error);
      categories = [];
    }
    renderCategoryCards();
  }

  function renderAnimeHero(worlds) {
    const showcase = $("#animeShowcase");
    if (!showcase) return;
    heroWorlds = Array.isArray(worlds) ? worlds.filter(x => x && x.heroEnabled !== false) : [];
    if (!heroWorlds.length) {
      showcase.innerHTML = '<div class="hero-empty">No anime worlds are enabled yet.<br><small>Open Admin → Anime Hero to add one.</small></div>';
      return;
    }
    showcase.style.setProperty("--hero-world-count", String(heroWorlds.length));
    showcase.style.setProperty("--hero-closed-basis", heroWorlds.length > 1 && heroWorlds.length <= 5 ? `${32 / (heroWorlds.length - 1)}%` : "8%");
    showcase.classList.toggle("single-world", heroWorlds.length === 1);
    showcase.innerHTML = heroWorlds.map((world, index) => {
      const name = String(world.name || "Anime");
      const image = mediaUrl(world.heroImage || world.image || "");
      const tag = String(world.heroTag || "Anime collection");
      const description = String(world.heroDescription || `Discover ${name} figures and collectibles at Aniverse.`);
      return `<article class="anime-panel ${index === 0 ? "active" : ""}" data-anime="${escapeHTML(name)}" data-hero-index="${index}">
        <div class="anime-bg" style="background-image:url('${escapeHTML(image || imageFallback)}')"></div>
        <span class="anime-number">${String(index + 1).padStart(2, "0")}</span>
        <span class="anime-vertical">${escapeHTML(name)}</span>
        <div class="anime-content">
          <span class="anime-tag">${escapeHTML(tag)}</span>
          <h2>${escapeHTML(name)}</h2>
          <p>${escapeHTML(description)}</p>
          <button class="anime-cta" type="button">Explore collection →</button>
        </div>
      </article>`;
    }).join("");
    bindAnimeSelector();
  }

  async function loadHeroWorlds() {
    try {
      const response = await api("/api/hero");
      renderAnimeHero(Array.isArray(response) ? response : []);
    } catch (error) {
      console.error("Hero load failed", error);
      const showcase = $("#animeShowcase");
      if (showcase) showcase.innerHTML = '<div class="hero-empty">Unable to load anime worlds. Please refresh.</div>';
    }
  }

  function bindAnimeSelector() {
    const showcase = $("#animeShowcase");
    const panels = $$("#animeShowcase .anime-panel");
    if (!showcase || !panels.length) return;
    const prev = $("#animeHeroPrev");
    const next = $("#animeHeroNext");
    let swipeMoved = false;
    let startX = 0;
    let startY = 0;
    let dragging = false;

    const isTouch = () => window.matchMedia("(hover:none), (pointer:coarse)").matches;
    const activate = (panel) => panels.forEach((item) => item.classList.toggle("active", item === panel));
    const currentIndex = () => {
      const x = showcase.scrollLeft;
      let best = 0, distance = Infinity;
      panels.forEach((panel, index) => {
        const d = Math.abs(panel.offsetLeft - x);
        if (d < distance) { distance = d; best = index; }
      });
      return best;
    };
    const updateArrows = () => {
      if (!prev || !next || isTouch()) return;
      const max = showcase.scrollWidth - showcase.clientWidth;
      prev.disabled = showcase.scrollLeft <= 4;
      next.disabled = showcase.scrollLeft >= max - 4;
    };
    const scrollByPage = (direction) => {
      const amount = Math.max(showcase.clientWidth * .72, 360);
      showcase.scrollBy({ left: direction * amount, behavior: "smooth" });
    };

    prev?.addEventListener("click", () => scrollByPage(-1));
    next?.addEventListener("click", () => scrollByPage(1));
    showcase.addEventListener("scroll", updateArrows, { passive: true });
    window.addEventListener("resize", updateArrows);

    showcase.addEventListener("pointerdown", (event) => {
      if (event.pointerType === "mouse") return;
      startX = event.clientX; startY = event.clientY; dragging = true; swipeMoved = false;
    }, { passive: true });
    showcase.addEventListener("pointermove", (event) => {
      if (!dragging || event.pointerType === "mouse") return;
      const dx = event.clientX - startX, dy = event.clientY - startY;
      if (Math.abs(dx) > 12 && Math.abs(dx) > Math.abs(dy)) swipeMoved = true;
    }, { passive: true });
    showcase.addEventListener("pointerup", (event) => {
      if (!dragging || event.pointerType === "mouse") return;
      const dx = event.clientX - startX;
      const threshold = Math.min(110, showcase.clientWidth * .16);
      if (Math.abs(dx) >= threshold && swipeMoved) scrollByPage(dx < 0 ? 1 : -1);
      dragging = false;
      setTimeout(() => { swipeMoved = false; }, 80);
    }, { passive: true });
    showcase.addEventListener("pointercancel", () => { dragging = false; swipeMoved = false; }, { passive: true });

    panels.forEach((panel) => {
      panel.addEventListener("mouseenter", () => { if (!isTouch()) activate(panel); });
      panel.addEventListener("click", (event) => {
        if (swipeMoved) { event.preventDefault(); return; }
        activate(panel);
        if (event.target.closest(".anime-cta") || event.target.closest(".anime-panel")) {
          event.preventDefault();
          openShop(panel.dataset.anime || "");
        }
      });
    });

    let settleTimer;
    showcase.addEventListener("scroll", () => {
      clearTimeout(settleTimer);
      settleTimer = setTimeout(() => { if (isTouch()) activate(panels[currentIndex()]); }, 100);
    }, { passive: true });
    window.addEventListener("resize", () => { if (isTouch()) activate(panels[currentIndex()]); });
    activate(panels[0]);
    updateArrows();
  }

  async function init() {
    bindEvents();
    updateCounts();
    updateChromeOffset();
    renderCart();

    await Promise.all([loadProducts(), loadCategories(), loadHeroWorlds()]);
    renderCategoryCards();
    if (window.location.hash === "#shop") openShop("");
    else if (window.location.hash === "#categories") openCategories();
    else if (window.location.hash) {
      try {
        const element = $(window.location.hash);
        if (element && element.id !== "shop") requestAnimationFrame(() => element.scrollIntoView({ behavior: "smooth", block: "start" }));
      } catch {
      }
    }
  }

  init().catch((error) => console.error(error));
})();
