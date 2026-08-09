BEGIN IMMEDIATE;

DROP TABLE IF EXISTS winner_loop_evidence;
DROP TABLE IF EXISTS subscription_events;
DROP TABLE IF EXISTS paid_test_safety_state;
DROP TABLE IF EXISTS paid_test_proposals;
DROP TABLE IF EXISTS paid_test_proposal_history;
DROP TABLE IF EXISTS creative_manifests;
DROP TABLE IF EXISTS spend_incidents;
DROP TABLE IF EXISTS spend_reservations;
DROP TABLE IF EXISTS spend_grants;

COMMIT;
