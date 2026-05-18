-- Explicit bid lifecycle statuses (carrier accept → shipper confirm; counters → counter_offered)
UPDATE bids SET status = 'pending_shipper_confirmation' WHERE status = 'pending';
UPDATE bids SET status = 'counter_offered' WHERE status = 'suggested';
