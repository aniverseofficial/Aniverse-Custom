# Anime Hero & Collections

The storefront anime hero is now database-driven from the `categories` collection.

## Admin
Open **Admin → Anime Hero** to:
- Add an anime world.
- Replace its hero image.
- Edit the hero tag and description.
- Change display order.
- Remove an anime from the hero without deleting its collection/products.

Open **Admin → Collections** to create, edit, or delete product collections. The collection editor also contains the **Show in Anime Hero** toggle and hero image fields.

## Hero images
Built-in starter images are in `public/images/hero/`. Recommended artwork is portrait, around 1600×2000 to 2000×2500. Admin-uploaded replacement images are stored under `/uploads/` and can be selected as the hero image.

## Data fields
Hero-enabled categories use:
- `heroEnabled`
- `heroImage`
- `heroTag`
- `heroDescription`
- `heroOrder`

The public storefront reads `/api/hero`, so hero changes made in Admin are reflected without editing `public/index.html`.
