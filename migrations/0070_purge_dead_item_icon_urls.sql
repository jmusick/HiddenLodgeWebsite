-- Hidden Lodge DB: drop item_icon_cache rows pointing at a dead zamimg path.
--
-- Before 6392a23 ("Fix item icons rewritten to a dead CDN path") every Blizzard
-- media url was rewritten onto zamimg's CDN, including the ones whose asset is a
-- numeric filename (133358.jpg). zamimg serves icons by *name*, so those rewrites
-- 404 and the raider/gear pages fall back to a question mark. The code fix stopped
-- new bad rows, but the ones already cached never expire — delete them so the next
-- icon lookup re-resolves them against Blizzard's render host.
--
-- Run locally:  npx wrangler d1 execute hidden-lodge-db --local --file=migrations/0070_purge_dead_item_icon_urls.sql
-- Run in prod:  npx wrangler d1 execute hidden-lodge-db --remote --file=migrations/0070_purge_dead_item_icon_urls.sql
--
-- Safe to rerun, and safe to lose: item_icon_cache is a pure cache, refilled on demand.
--
-- allow-destructive

DELETE FROM item_icon_cache
WHERE icon_url LIKE 'https://wow.zamimg.com/images/wow/icons/large/%'
  AND substr(replace(icon_url, 'https://wow.zamimg.com/images/wow/icons/large/', ''), 1, 1) BETWEEN '0' AND '9';
