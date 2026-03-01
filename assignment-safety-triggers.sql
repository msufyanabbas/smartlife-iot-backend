-- src/database/migrations/XXXXXXXXXXXXXX-assignment-safety-triggers.sql
-- Run this as a TypeORM migration or raw SQL against your PostgreSQL database.
-- These triggers are your last line of defense — they fire even on direct DB writes.

-- ─────────────────────────────────────────────────────────────────────────────
-- TRIGGER 1: Cross-tenant enforcement on customer_devices
-- Ensures the device being assigned belongs to the same tenant as the customer
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION check_customer_device_tenant()
RETURNS TRIGGER AS $$
BEGIN
  -- Verify device belongs to the same tenant as the customer
  IF NOT EXISTS (
    SELECT 1
    FROM devices d
    JOIN customers c ON c.id = NEW."customerId"
    WHERE d.id = NEW."deviceId"
      AND d."tenantId" = c."tenantId"
      AND d."tenantId" = NEW."tenantId"
  ) THEN
    RAISE EXCEPTION
      'Cross-tenant violation: device % does not belong to tenant of customer %',
      NEW."deviceId", NEW."customerId";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_customer_device_tenant ON customer_devices;
CREATE TRIGGER trg_customer_device_tenant
  BEFORE INSERT OR UPDATE ON customer_devices
  FOR EACH ROW EXECUTE FUNCTION check_customer_device_tenant();

-- ─────────────────────────────────────────────────────────────────────────────
-- TRIGGER 2: Customer-to-user consistency on user_devices
-- Ensures the device is already assigned to the user's customer
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION check_user_device_customer_consistency()
RETURNS TRIGGER AS $$
DECLARE
  user_customer_id UUID;
BEGIN
  -- Get the user's customerId
  SELECT "customerId" INTO user_customer_id
  FROM users
  WHERE id = NEW."userId";

  -- Verify: customerId on the row must match user's actual customerId
  IF user_customer_id IS DISTINCT FROM NEW."customerId" THEN
    RAISE EXCEPTION
      'Consistency violation: userId % belongs to customer %, not %',
      NEW."userId", user_customer_id, NEW."customerId";
  END IF;

  -- Verify: device must already be assigned to this customer
  IF NOT EXISTS (
    SELECT 1 FROM customer_devices
    WHERE "deviceId" = NEW."deviceId"
      AND "customerId" = NEW."customerId"
      AND "tenantId" = NEW."tenantId"
  ) THEN
    RAISE EXCEPTION
      'Consistency violation: device % must be assigned to customer % before assigning to user %',
      NEW."deviceId", NEW."customerId", NEW."userId";
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_user_device_customer ON user_devices;
CREATE TRIGGER trg_user_device_customer
  BEFORE INSERT OR UPDATE ON user_devices
  FOR EACH ROW EXECUTE FUNCTION check_user_device_customer_consistency();

-- ─────────────────────────────────────────────────────────────────────────────
-- TRIGGER 3: Cross-tenant enforcement on customer_dashboards
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION check_customer_dashboard_tenant()
RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM dashboards d
    JOIN customers c ON c.id = NEW."customerId"
    WHERE d.id = NEW."dashboardId"
      AND d."tenantId" = c."tenantId"
      AND d."tenantId" = NEW."tenantId"
  ) THEN
    RAISE EXCEPTION
      'Cross-tenant violation: dashboard % does not belong to tenant of customer %',
      NEW."dashboardId", NEW."customerId";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_customer_dashboard_tenant ON customer_dashboards;
CREATE TRIGGER trg_customer_dashboard_tenant
  BEFORE INSERT OR UPDATE ON customer_dashboards
  FOR EACH ROW EXECUTE FUNCTION check_customer_dashboard_tenant();

-- ─────────────────────────────────────────────────────────────────────────────
-- TRIGGER 4: User-to-customer consistency on user_dashboards
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION check_user_dashboard_customer_consistency()
RETURNS TRIGGER AS $$
DECLARE
  user_customer_id UUID;
BEGIN
  SELECT "customerId" INTO user_customer_id FROM users WHERE id = NEW."userId";

  IF user_customer_id IS DISTINCT FROM NEW."customerId" THEN
    RAISE EXCEPTION 'Consistency violation: userId % belongs to customer %, not %',
      NEW."userId", user_customer_id, NEW."customerId";
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM customer_dashboards
    WHERE "dashboardId" = NEW."dashboardId"
      AND "customerId" = NEW."customerId"
      AND "tenantId" = NEW."tenantId"
  ) THEN
    RAISE EXCEPTION 'Consistency violation: dashboard % must be assigned to customer % first',
      NEW."dashboardId", NEW."customerId";
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_user_dashboard_customer ON user_dashboards;
CREATE TRIGGER trg_user_dashboard_customer
  BEFORE INSERT OR UPDATE ON user_dashboards
  FOR EACH ROW EXECUTE FUNCTION check_user_dashboard_customer_consistency();

-- ─────────────────────────────────────────────────────────────────────────────
-- TRIGGER 5 & 6: Assets
-- ─────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION check_customer_asset_tenant()
RETURNS TRIGGER AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM assets a JOIN customers c ON c.id = NEW."customerId"
    WHERE a.id = NEW."assetId" AND a."tenantId" = c."tenantId" AND a."tenantId" = NEW."tenantId"
  ) THEN
    RAISE EXCEPTION 'Cross-tenant violation on asset assignment';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_customer_asset_tenant ON customer_assets;
CREATE TRIGGER trg_customer_asset_tenant
  BEFORE INSERT OR UPDATE ON customer_assets
  FOR EACH ROW EXECUTE FUNCTION check_customer_asset_tenant();

CREATE OR REPLACE FUNCTION check_user_asset_consistency()
RETURNS TRIGGER AS $$
DECLARE user_customer_id UUID;
BEGIN
  SELECT "customerId" INTO user_customer_id FROM users WHERE id = NEW."userId";
  IF user_customer_id IS DISTINCT FROM NEW."customerId" THEN
    RAISE EXCEPTION 'Consistency violation on user_assets: customer mismatch';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM customer_assets
    WHERE "assetId" = NEW."assetId" AND "customerId" = NEW."customerId"
  ) THEN
    RAISE EXCEPTION 'Consistency violation: asset must be in customer_assets first';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_user_asset_customer ON user_assets;
CREATE TRIGGER trg_user_asset_customer
  BEFORE INSERT OR UPDATE ON user_assets
  FOR EACH ROW EXECUTE FUNCTION check_user_asset_consistency();

-- ─────────────────────────────────────────────────────────────────────────────
-- NOTE: Add identical trigger pairs for:
--   customer_floor_plans / user_floor_plans
--   customer_automations / user_automations
-- Following the exact same pattern as above.
-- ─────────────────────────────────────────────────────────────────────────────