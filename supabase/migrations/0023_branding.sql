-- ISPMan: company branding — a logo and one brand colour.
--
-- RUN THIS IN THE SUPABASE SQL EDITOR. Requires 0022_email_channel.sql.
--
-- WHAT THIS DOES. Gives a company a logo and a colour, used in exactly two
-- places: the header of every HTML email and the letterhead of every A4 PDF.
-- Both read them through lib/data/brand.ts#brandFor, so there is one answer to
-- "what does this company look like" and the two cannot disagree.
--
-- WHAT IT DOES NOT DO. Nothing changes for a company that never opens the
-- Branding card: no logo means its name is set as a wordmark, no colour means
-- the platform default. The outbox is untouched — HTML is rendered at send
-- time from the text body that is already stored, the same way attachments
-- are rendered from the record they name.

-- ---------------------------------------------------------------------------
-- 1. Settings: where the logo is, and the colour
-- ---------------------------------------------------------------------------
ALTER TABLE public.settings
  -- The object's path inside the `company-assets` bucket, e.g.
  -- '12/logo-1789654321000.png'. NULL means no logo. The path carries a
  -- timestamp so a replaced logo is a NEW object: nothing between the bucket
  -- and the dispatcher can serve the old bytes under the new name.
  --
  -- ONE FILE. What is stored is not the upload but a normalised derivative —
  -- an 8-bit RGB PNG, flattened onto white, inside 640x240 — and that one
  -- file is what the email embeds and what the PDF embeds. There is no second
  -- rendition and no second path; see lib/logo.ts.
  ADD COLUMN IF NOT EXISTS logo_path TEXT,

  -- '#rrggbb', lowercase. NULL means the platform default. ONE colour: the
  -- accent rule, the button and the wordmark are all derived from it, and the
  -- text colours that sit on or beside it are chosen by contrast rather than
  -- by the company (lib/brand.ts#brandPalette).
  ADD COLUMN IF NOT EXISTS brand_color VARCHAR(7);

ALTER TABLE public.settings DROP CONSTRAINT IF EXISTS settings_brand_color_check;
ALTER TABLE public.settings ADD CONSTRAINT settings_brand_color_check
  CHECK (brand_color IS NULL OR brand_color ~ '^#[0-9a-f]{6}$');

-- ---------------------------------------------------------------------------
-- 2. The bucket: private
-- ---------------------------------------------------------------------------
-- PRIVATE, and nothing serves it to the world. An email client never fetches
-- the logo: the bytes travel inside each message as an inline (CID)
-- attachment, so there is no public URL to expire, to block, or to leak. The
-- app reads the bucket with the service role, and every path is built from
-- the session's company id — the same rule lib/supabase/tenant.ts sets for
-- table reads.
--
-- PNG only and 1 MB, because the only thing ever written here is the
-- derivative above, which is far smaller. The limits are a backstop against a
-- code path that forgets to normalise, not the upload limit a person meets.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('company-assets', 'company-assets', false, 1048576, ARRAY['image/png'])
ON CONFLICT (id) DO NOTHING;

-- No storage policies: with none defined, only the service role can read or
-- write, which is what is wanted.
