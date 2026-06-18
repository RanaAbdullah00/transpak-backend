-- Capacity listing + request lifecycle statuses (open → requested → accepted → active → delivered → closed | expired)

ALTER TABLE carrier_space_listings DROP CONSTRAINT IF EXISTS carrier_space_status;

UPDATE carrier_space_listings SET status = 'accepted' WHERE status = 'booked';

UPDATE carrier_space_listings
SET status = 'expired'
WHERE status = 'closed'
  AND (
    (available_from IS NOT NULL AND available_from < CURRENT_DATE)
    OR EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(availability_slots, '[]'::jsonb)) elem
      WHERE elem->>'type' = 'visibility'
        AND elem->>'visibleUntil' IS NOT NULL
        AND (elem->>'visibleUntil')::timestamptz < now()
    )
  );

ALTER TABLE carrier_space_listings ADD CONSTRAINT carrier_space_status CHECK (
  status IN ('open', 'requested', 'accepted', 'active', 'delivered', 'closed', 'expired')
);

ALTER TABLE carrier_space_requests DROP CONSTRAINT IF EXISTS carrier_space_req_status;

ALTER TABLE carrier_space_requests ADD CONSTRAINT carrier_space_req_status CHECK (
  status IN (
    'request_sent', 'accepted', 'rejected', 'active', 'in_transit',
    'delivered', 'completed', 'expired'
  )
);
