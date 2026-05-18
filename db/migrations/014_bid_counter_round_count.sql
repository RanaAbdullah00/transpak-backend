-- Track counter-offer rounds per bid (max enforced in API)
ALTER TABLE bids ADD COLUMN IF NOT EXISTS counter_round_count int NOT NULL DEFAULT 0;
