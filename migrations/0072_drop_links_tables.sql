-- allow-destructive
-- The public /links page now renders bookmarks from the Tagstash API (tag "wow")
-- instead of D1, and the /admin/links CRUD screen has been removed with it.
-- Drop the now-unused tables.

DROP INDEX IF EXISTS idx_links_sort;
DROP INDEX IF EXISTS idx_link_categories_sort;
DROP INDEX IF EXISTS idx_links_category_id;
DROP TABLE IF EXISTS links;
DROP TABLE IF EXISTS link_categories;
