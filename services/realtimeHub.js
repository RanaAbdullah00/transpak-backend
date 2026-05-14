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

module.exports = {
  setIO,
  getIO,
  emitToUser,
  emitToConversation
};
