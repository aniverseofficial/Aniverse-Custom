# Aniverse Storefront Production Pass

## Navigation
The storefront now uses a single global surface/layer system. Search, cart, wishlist/shop, product detail, checkout, and mobile navigation are available from every storefront state. The overlay top offset is measured from the actual sticky header instead of assuming a fixed pixel offset, so the announcement bar and mobile header are handled correctly.

## Categories
The storefront category directory includes the current public Aniverse category/collection names and merges them with categories returned by MongoDB. Products can still belong to multiple categories through the existing product category array.

Current source-derived category names include: Premium Figures, New Arrivals, Pre Orders, Keychains, Katanas, Mini Figurine Sets, Miniature Sets, Merchandise, Anime Lamps, Fancy Lamps, Banpresto Figures, Banpresto, Funko, Funko Pop, Qposket, Attack On Titan, Bleach, Blue Lock, Chainsaw Man, Dandadan, Death Note, Demon Slayer, DIY Blocks, Dragon Ball, Figurines, Harry Potter, Hunter X Hunter, Jujutsu Kaisen, K-POP Demon Hunters, Kaiju No.8, Marvel, My Hero Academia, Naruto, Onepiece, Solo Leveling.

## Production notes
- Keep the existing `.env` and MongoDB database.
- Do not delete existing indexes.
- Product/category image uploads should move to persistent object storage before deployment.
- Run `npm start` and then `npm run smoke` against the real environment before going live.
