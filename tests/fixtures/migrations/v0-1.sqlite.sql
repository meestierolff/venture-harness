-- Synthetic prior-version database used to prove the Core v0.1 -> v0.2 path.
CREATE TABLE fixture_runtime_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  schema_version TEXT NOT NULL
) STRICT;

INSERT INTO fixture_runtime_meta (singleton, schema_version) VALUES (1, '0.1.0');

CREATE TABLE fixture_launches (
  launch_id TEXT PRIMARY KEY,
  venture_slug TEXT NOT NULL
) STRICT;

INSERT INTO fixture_launches (launch_id, venture_slug)
VALUES ('launch-v01', 'shared-slug');
