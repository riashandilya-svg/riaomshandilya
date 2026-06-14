-- ============================================================
-- SUPABASE ROW LEVEL SECURITY POLICIES
-- Run this in your Supabase SQL Editor (Dashboard → SQL Editor)
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 1. ORDERS TABLE
-- ────────────────────────────────────────────────────────────

-- Enable RLS (safe to run even if already enabled)
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;

-- Drop any existing permissive policies that may be too broad
DROP POLICY IF EXISTS "Allow anon full access" ON orders;
DROP POLICY IF EXISTS "Allow all access" ON orders;
DROP POLICY IF EXISTS "Enable insert for anon" ON orders;
DROP POLICY IF EXISTS "Enable select for anon" ON orders;
DROP POLICY IF EXISTS "Enable update for anon" ON orders;
DROP POLICY IF EXISTS "Enable delete for anon" ON orders;

-- Anon users: can only read their own orders by email
-- (used by orders.html tracking page)
CREATE POLICY "Anon can read own orders by email"
  ON orders FOR SELECT
  TO anon
  USING (
    email = current_setting('request.headers')::json->>'x-customer-email'
  );

-- If the above header-based approach doesn't fit your flow,
-- use this simpler alternative instead (comment out the above, uncomment below).
-- This allows anon SELECT but only specific columns via a Supabase view or Edge Function.
-- CREATE POLICY "Anon can read orders" ON orders FOR SELECT TO anon USING (true);

-- Anon users: NO insert, update, or delete
-- (orders are now created by the confirm-order edge function using service_role)
CREATE POLICY "Anon cannot insert orders"
  ON orders FOR INSERT
  TO anon
  WITH CHECK (false);

CREATE POLICY "Anon cannot update orders"
  ON orders FOR UPDATE
  TO anon
  USING (false);

CREATE POLICY "Anon cannot delete orders"
  ON orders FOR DELETE
  TO anon
  USING (false);

-- Authenticated admin: full access
CREATE POLICY "Admin can read all orders"
  ON orders FOR SELECT
  TO authenticated
  USING (true);

CREATE POLICY "Admin can update orders"
  ON orders FOR UPDATE
  TO authenticated
  USING (true)
  WITH CHECK (true);

-- service_role bypasses RLS automatically, so the confirm-order
-- edge function can insert orders without a specific policy.

-- ────────────────────────────────────────────────────────────
-- 2. WEBAUTHN_CREDENTIALS TABLE
-- ────────────────────────────────────────────────────────────

ALTER TABLE webauthn_credentials ENABLE ROW LEVEL SECURITY;

-- Drop overly permissive policies
DROP POLICY IF EXISTS "Allow anon full access" ON webauthn_credentials;
DROP POLICY IF EXISTS "Allow all access" ON webauthn_credentials;

-- Anon users: NO access at all
CREATE POLICY "Anon cannot read credentials"
  ON webauthn_credentials FOR SELECT
  TO anon
  USING (false);

CREATE POLICY "Anon cannot insert credentials"
  ON webauthn_credentials FOR INSERT
  TO anon
  WITH CHECK (false);

CREATE POLICY "Anon cannot update credentials"
  ON webauthn_credentials FOR UPDATE
  TO anon
  USING (false);

CREATE POLICY "Anon cannot delete credentials"
  ON webauthn_credentials FOR DELETE
  TO anon
  USING (false);

-- Authenticated users: can only manage their own credentials
CREATE POLICY "Users can read own credentials"
  ON webauthn_credentials FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

CREATE POLICY "Users can insert own credentials"
  ON webauthn_credentials FOR INSERT
  TO authenticated
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "Users can delete own credentials"
  ON webauthn_credentials FOR DELETE
  TO authenticated
  USING (user_id = auth.uid());

-- ────────────────────────────────────────────────────────────
-- 3. VERIFY: Check that RLS is enabled
-- ────────────────────────────────────────────────────────────
SELECT tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN ('orders', 'webauthn_credentials');
