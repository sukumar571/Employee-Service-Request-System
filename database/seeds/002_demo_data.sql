-- Seed 002: demo data for local development and the internship showcase.
--
-- The password hash is NOT committed: `npm run db:seed` replaces {{DEMO_PASSWORD_HASH}} with a
-- bcrypt hash generated at run time from SEED_DEMO_PASSWORD (development default documented in
-- database/README.md). Every demo account is created with must_change_password = true (ST-104),
-- so the seeded password is only ever a first-login credential.
--
-- Idempotent: re-running produces the same set, no duplicates.

BEGIN;

INSERT INTO users (id, email, password_hash, full_name, role, department_id, team_category_id, must_change_password)
OVERRIDING SYSTEM VALUE VALUES
  (1, 'demo.employee@company.test',   '{{DEMO_PASSWORD_HASH}}', 'Demo Employee',   'employee', 1, NULL, true),
  (2, 'demo.agent@company.test',      '{{DEMO_PASSWORD_HASH}}', 'Demo Agent',      'agent',    1, 1,    true),
  (3, 'demo.manager@company.test',    '{{DEMO_PASSWORD_HASH}}', 'Demo Manager',    'manager',  1, 1,    true),
  (4, 'demo.admin@company.test',      '{{DEMO_PASSWORD_HASH}}', 'Demo Administrator', 'admin', NULL, NULL, true),
  (5, 'demo.hr-agent@company.test',   '{{DEMO_PASSWORD_HASH}}', 'Demo HR Agent',   'agent',    2, 2,    true)
ON CONFLICT DO NOTHING;

SELECT setval(pg_get_serial_sequence('users', 'id'), (SELECT GREATEST(MAX(id), 1) FROM users));

-- One submitted, one in progress (with a tracker) and one resolved request.
INSERT INTO requests (
  id, request_number, requester_id, assignee_id, category_id, sub_category_id, department_id,
  title, description, status, priority, resolution_note, submitted_at, resolved_at, version
) OVERRIDING SYSTEM VALUE VALUES
  (1, 'REQ-DEMO-000001', 1, NULL, 1, 2, 1,
   'Install design software on new laptop',
   'Please install the approved design suite on my replacement laptop before Monday.',
   'submitted', 'medium', NULL, now() - interval '3 hours', NULL, 1),
  (2, 'REQ-DEMO-000002', 1, 2, 1, 3, 1,
   'VPN access for remote work',
   'I need remote VPN access to work from home on the project shared drive.',
   'in_progress', 'high', NULL, now() - interval '26 hours', NULL, 3),
  (3, 'REQ-DEMO-000003', 1, 5, 2, 9, 2,
   'Employment letter for visa application',
   'I require an employment letter stating my role and joining date for a visa application.',
   'resolved', 'low', 'Letter issued and handed over to the employee.',
   now() - interval '4 days', now() - interval '1 days', 4)
ON CONFLICT DO NOTHING;

SELECT setval(pg_get_serial_sequence('requests', 'id'), (SELECT GREATEST(MAX(id), 1) FROM requests));

INSERT INTO assignments (request_id, agent_id, assigned_by, reason)
VALUES (2, 2, 3, 'manager_assign'), (3, 5, 3, 'manager_assign')
ON CONFLICT DO NOTHING;

-- SLA trackers: due dates are illustrative; the API recomputes business-time maths from the policy.
INSERT INTO sla_trackers (
  request_id, policy_snapshot, submitted_at, first_response_due_at, resolution_due_at,
  first_response_met_at, completion_status
)
VALUES
  (1, '{"priority":"medium","first_response_mins":240,"resolution_mins":1620}',
     now() - interval '3 hours', now() - interval '1 hour', now() + interval '20 hours', NULL, NULL),
  (2, '{"priority":"high","first_response_mins":120,"resolution_mins":1440}',
     now() - interval '26 hours', now() - interval '24 hours', now() + interval '4 hours',
     now() - interval '25 hours', NULL),
  (3, '{"priority":"low","first_response_mins":480,"resolution_mins":2700}',
     now() - interval '4 days', now() - interval '3 days', now() + interval '2 days',
     now() - interval '3 days', 'met')
ON CONFLICT (request_id) DO NOTHING;

INSERT INTO request_events (request_id, actor_id, actor_role, event_type, from_status, to_status, detail)
VALUES
  (1, 1, 'employee', 'created',   NULL, 'draft',     '{"source":"seed"}'),
  (1, 1, 'employee', 'submitted', 'draft', 'submitted', '{}'),
  (2, 1, 'employee', 'submitted', 'draft', 'submitted', '{}'),
  (2, 3, 'manager',  'assigned',  'submitted', 'assigned', '{"agent_id":2}'),
  (2, 2, 'agent',    'started',   'assigned', 'in_progress', '{}'),
  (3, 5, 'agent',    'resolved',  'in_progress', 'resolved', '{"note":"Letter issued"}')
ON CONFLICT DO NOTHING;

COMMIT;
