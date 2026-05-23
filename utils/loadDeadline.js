/** Bidding deadline helpers — minutes primary, hours legacy. */

const MIN_DEADLINE_MINUTES = 15;
const MAX_DEADLINE_MINUTES = 72 * 60;

function resolveDeadlineMinutes(load) {
  if (!load) return 120;
  if (load.deadline_minutes != null && Number.isFinite(Number(load.deadline_minutes))) {
    return Number(load.deadline_minutes);
  }
  const hours = Number(load.deadline_hours ?? load.deadlineHours ?? 2);
  return Math.max(1, Math.round(hours * 60));
}

function parseDeadlineMinutesFromBody(body = {}) {
  if (body.deadlineMinutes != null && body.deadlineMinutes !== "") {
    const m = Number(body.deadlineMinutes);
    if (Number.isFinite(m) && m >= MIN_DEADLINE_MINUTES && m <= MAX_DEADLINE_MINUTES) {
      return Math.round(m);
    }
    return null;
  }
  if (body.deadlineHours != null && body.deadlineHours !== "") {
    const h = Number(body.deadlineHours);
    if (Number.isFinite(h) && h > 0 && h <= 72) {
      return Math.round(h * 60);
    }
    return null;
  }
  return null;
}

function biddingEndsAtIso(load) {
  const created = load?.created_at ?? load?.createdAt;
  if (!created) return null;
  const mins = resolveDeadlineMinutes(load);
  return new Date(new Date(created).getTime() + mins * 60000).toISOString();
}

function isBiddingOpen(load) {
  const ends = biddingEndsAtIso(load);
  if (!ends) return true;
  return Date.now() < new Date(ends).getTime();
}

module.exports = {
  MIN_DEADLINE_MINUTES,
  MAX_DEADLINE_MINUTES,
  resolveDeadlineMinutes,
  parseDeadlineMinutesFromBody,
  biddingEndsAtIso,
  isBiddingOpen
};
