ALTER TABLE carrier_space_requests DROP CONSTRAINT IF EXISTS carrier_space_req_status;
ALTER TABLE carrier_space_requests ADD CONSTRAINT carrier_space_req_status CHECK (
  status IN ('request_sent', 'accepted', 'rejected', 'active', 'in_transit', 'completed')
);
