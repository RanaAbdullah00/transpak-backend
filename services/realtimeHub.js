/** Socket.io instance injected at server bootstrap (avoids circular requires). */
let io = null;

function setIO(instance) {
  io = instance;
}

function emitToUser(userId, event, payload) {
  if (!io || !userId) return;
  try {
    io.to(`user:${String(userId)}`).emit(event, payload);
  } catch {
    // ignore emit failures
  }
}

function emitToConversation(conversationId, event, payload) {
  if (!io || !conversationId) return;
  try {
    io.to(`conv:${String(conversationId)}`).emit(event, payload);
  } catch {
    // ignore
  }
}

function getIO() {
  return io;
}

function getConnectedSocketCount() {
  if (!io) return 0;
  try {
    if (typeof io.engine?.clientsCount === "number") return io.engine.clientsCount;
    if (io.sockets?.sockets?.size != null) return io.sockets.sockets.size;
  } catch {
    // ignore
  }
  return 0;
}

function emitToTracking(refKey, event, payload) {
  if (!io || !refKey) return;
  try {
    io.to(`track:${String(refKey)}`).emit(event, payload);
  } catch {
    // ignore
  }
}

module.exports = {
  setIO,
  getIO,
  getConnectedSocketCount,
  emitToUser,
  emitToConversation,
  emitToTracking
};
