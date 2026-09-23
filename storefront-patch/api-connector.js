// ANIVERSE STOREFRONT MONGODB/API CONNECTOR
// Add this after your existing app.js, or merge the functions into the current storefront.
// Set API_BASE to the public URL of the Aniverse admin/API server in production.
const API_BASE = window.ANIVERSE_API_BASE || "http://localhost:4000";

async function loadMongoProducts() {
  try {
    const response = await fetch(`${API_BASE}/api/products?limit=100`);
    if (!response.ok) return;
    const remoteProducts = await response.json();
    if (!Array.isArray(remoteProducts) || !remoteProducts.length) return;

    // Normalize common MongoDB catalogue shapes to the current storefront card shape.
    const normalized = remoteProducts.map(p => ({
      id: p._id || p.id,
      name: p.name || p.title || "Untitled product",
      category: p.category || p.anime || p.collection || "Anime Collectible",
      price: Number(p.price || p.salePrice || 0),
      old: Number(p.compareAtPrice || p.oldPrice || 0) || null,
      badge: p.badge || (p.isPreorder ? "PRE-ORDER" : "AVAILABLE"),
      img: p.images?.[0] || p.image || p.thumbnail || ""
    })).filter(p => p.img);

    // Replace the hardcoded catalogue in the storefront.
    products.length = 0;
    products.push(...normalized);

    if (typeof render === "function") {
      render("productGrid", products.slice(0,4));
      render("preorderGrid", products.filter(p => p.badge === "PRE-ORDER").slice(0,4));
      render("shopGrid", products);
    }
  } catch (error) {
    console.warn("MongoDB storefront API unavailable; keeping local catalogue.", error);
  }
}

loadMongoProducts();
