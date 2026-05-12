export function createRealtimeClient({ getUrl, onDisabled, onOpen, onClose, onMessage }) {
  let socket = null;
  let reconnectTimer = null;
  let pendingMessages = [];
  let intentionalDisconnect = false;

  function connect() {
    if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) {
      return;
    }

    const wsUrl = getUrl();

    if (!wsUrl) {
      onDisabled?.();
      return;
    }

    intentionalDisconnect = false;
    socket = new WebSocket(wsUrl);

    socket.addEventListener("open", () => {
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }

      flushPendingMessages();
      onOpen?.();
    });

    socket.addEventListener("close", () => {
      const intentional = intentionalDisconnect;
      socket = null;
      onClose?.({ intentional });

      if (!intentional) {
        reconnectTimer = setTimeout(connect, 1200);
      }
    });

    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      onMessage?.(message);
    });
  }

  function send(type, payload = {}) {
    const message = JSON.stringify({ type, payload });

    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(message);
      return true;
    }

    if (socket?.readyState === WebSocket.CONNECTING) {
      pendingMessages.push(message);
    }

    return false;
  }

  function flushPendingMessages() {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;

    for (const message of pendingMessages) {
      socket.send(message);
    }
    pendingMessages = [];
  }

  function isConnected() {
    return socket?.readyState === WebSocket.OPEN;
  }

  function isConnecting() {
    return socket?.readyState === WebSocket.CONNECTING;
  }

  function disconnect() {
    intentionalDisconnect = true;
    pendingMessages = [];
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (socket) {
      socket.close();
      socket = null;
    }
  }

  function getStatus() {
    if (isConnected()) return "connected";
    if (isConnecting()) return "connecting";
    return "idle";
  }

  function clearPendingMessages() {
    pendingMessages = [];
  }

  function sendNow(type, payload = {}) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify({ type, payload }));
    return true;
  }

  return {
    connect,
    disconnect,
    send,
    sendNow,
    getStatus,
    clearPendingMessages
  };
}
