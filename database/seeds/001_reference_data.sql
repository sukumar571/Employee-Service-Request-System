-- Seed 001: reference data (taxonomy) — idempotent, safe to re-run.
-- SLA policy rows and app_settings defaults live in migrations 010 and 014 because the API
-- cannot function without them; only the editable catalogue lives here.

BEGIN;

INSERT INTO departments (id, name) OVERRIDING SYSTEM VALUE VALUES
  (1, 'Information Technology'),
  (2, 'Human Resources'),
  (3, 'Facilities'),
  (4, 'Finance'),
  (5, 'Sales')
ON CONFLICT DO NOTHING;

-- `default_resolution_hours` is the taxonomy-level SLA default the spec requires; the authoritative
-- clock still runs on the priority-based sla_policies (see migration 015).
INSERT INTO categories (id, code, name, team_label, description, default_resolution_hours) OVERRIDING SYSTEM VALUE VALUES
  (1, 'IT', 'Information Technology', 'IT Support',
      'Hardware, software, network and access requests for the IT Support team.', 24),
  (2, 'HR', 'Human Resources', 'HR Team',
      'Onboarding, leave, payroll and policy requests handled by the HR team.', 48),
  (3, 'FAC', 'Facilities', 'Facilities Team',
      'Workspace, cleaning, electrical and supplies requests for the Facilities team.', 72)
ON CONFLICT (id) DO UPDATE
  SET description = EXCLUDED.description,
      default_resolution_hours = EXCLUDED.default_resolution_hours;

-- docs/database-design.md §2.2 seed list: five sub-categories per team.
INSERT INTO sub_categories (id, category_id, name) OVERRIDING SYSTEM VALUE VALUES
  (1, 1, 'Hardware'),
  (2, 1, 'Software'),
  (3, 1, 'Network & VPN'),
  (4, 1, 'Email & Access'),
  (5, 1, 'Peripherals'),
  (6, 2, 'Onboarding'),
  (7, 2, 'Leave & Attendance'),
  (8, 2, 'Payroll & Benefits'),
  (9, 2, 'Employment Letter'),
  (10, 2, 'Policy Query'),
  (11, 3, 'Workspace & Seating'),
  (12, 3, 'Cleaning'),
  (13, 3, 'Electrical'),
  (14, 3, 'Security Access'),
  (15, 3, 'Books & Supplies')
ON CONFLICT DO NOTHING;

-- Keep the identity sequences ahead of the explicitly inserted rows.
SELECT setval(pg_get_serial_sequence('departments', 'id'),   (SELECT GREATEST(MAX(id), 1) FROM departments));
SELECT setval(pg_get_serial_sequence('categories', 'id'),    (SELECT GREATEST(MAX(id), 1) FROM categories));
SELECT setval(pg_get_serial_sequence('sub_categories', 'id'),(SELECT GREATEST(MAX(id), 1) FROM sub_categories));

COMMIT;
