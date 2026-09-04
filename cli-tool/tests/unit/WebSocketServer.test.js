/**
 * Unit Tests for WebSocketServer
 * Tests real-time communication server
 */

// Mock the WebSocket library.
//
// This is declared ABOVE the requires on purpose. jest.config.js currently sets
// `transform: {}`, which disables babel-plugin-jest-hoist, so jest.mock() calls
// are not lifted above the require() calls. Left in its original position the
// real `ws` module was captured first, and `WebSocket.Server.mockImplementation`
// threw "is not a function". An explicit factory also avoids relying on
// automock to reconstruct the module's shape.
jest.mock('ws', () => {
  const MockServer = jest.fn();
  return {
    Server: MockServer,
    // Numeric readyState constants, matching the real ws module.
    CONNECTING: 0,
    OPEN: 1,
    CLOSING: 2,
    CLOSED: 3,
  };
});

const WebSocketServer = require('../../src/analytics/notifications/WebSocketServer');
const WebSocket = require('ws');

describe('WebSocketServer', () => {
  let webSocketServer;
  let mockHttpServer;
  let mockWss;
  let mockWs;

  beforeEach(() => {
    // Mock HTTP server
    mockHttpServer = {
      listen: jest.fn(),
      close: jest.fn()
    };

    // Mock WebSocket server
    mockWss = {
      on: jest.fn(),
      // The real ws Server.close(cb) invokes its callback once shutdown
      // finishes, and WebSocketServer.close() awaits exactly that:
      //   await new Promise((resolve) => this.wss.close(resolve));
      // A bare jest.fn() never calls back, so that promise never settled and
      // the close test sat until Jest's 30s timeout.
      close: jest.fn((callback) => {
        if (typeof callback === 'function') callback();
      }),
      clients: new Set()
    };

    // Mock WebSocket connection
    mockWs = {
      on: jest.fn(),
      send: jest.fn(),
      close: jest.fn(),
      terminate: jest.fn(),
      ping: jest.fn(),
      readyState: WebSocket.OPEN
    };

    // Mock WebSocket.Server constructor
    WebSocket.Server.mockImplementation(() => mockWss);

    webSocketServer = new WebSocketServer(mockHttpServer);
  });

  afterEach(() => {
    // Every test builds a fresh server, and initialize() starts a heartbeat
    // interval. Without stopping it the timer outlives its test, then fires
    // against that old instance's client map - which in some tests holds
    // entries with no `ws` - throwing "Cannot read properties of undefined
    // (reading 'readyState')" inside whichever test is running 30s later.
    if (webSocketServer && typeof webSocketServer.stopHeartbeat === 'function') {
      webSocketServer.stopHeartbeat();
    }
    jest.clearAllMocks();
  });

  describe('constructor', () => {
    it('should initialize with default options', () => {
      expect(webSocketServer.httpServer).toBe(mockHttpServer);
      expect(webSocketServer.options.port).toBe(3334);
      expect(webSocketServer.options.path).toBe('/ws');
      expect(webSocketServer.isRunning).toBe(false);
      expect(webSocketServer.clients).toBeInstanceOf(Map);
    });

    it('should accept custom options', () => {
      const customServer = new WebSocketServer(mockHttpServer, {
        port: 4444,
        path: '/websocket',
        heartbeatInterval: 60000
      });

      expect(customServer.options.port).toBe(4444);
      expect(customServer.options.path).toBe('/websocket');
      expect(customServer.options.heartbeatInterval).toBe(60000);
    });
  });

  describe('initialize', () => {
    it('should create WebSocket server with correct options', async () => {
      await webSocketServer.initialize();

      expect(WebSocket.Server).toHaveBeenCalledWith({
        server: mockHttpServer,
        path: '/ws',
        clientTracking: true
      });
      expect(webSocketServer.isRunning).toBe(true);
    });

    it('should setup event handlers', async () => {
      await webSocketServer.initialize();

      expect(mockWss.on).toHaveBeenCalledWith('connection', expect.any(Function));
      expect(mockWss.on).toHaveBeenCalledWith('error', expect.any(Function));
      expect(mockWss.on).toHaveBeenCalledWith('close', expect.any(Function));
    });

    it('should handle initialization errors', async () => {
      WebSocket.Server.mockImplementation(() => {
        throw new Error('Failed to create WebSocket server');
      });

      await expect(webSocketServer.initialize()).rejects.toThrow('Failed to create WebSocket server');
    });
  });

  describe('handleConnection', () => {
    beforeEach(async () => {
      await webSocketServer.initialize();
    });

    it('should register new client and setup handlers', () => {
      const mockRequest = {
        socket: { remoteAddress: '127.0.0.1' },
        headers: { 'user-agent': 'test-client' }
      };

      // Simulate connection event
      const connectionHandler = mockWss.on.mock.calls.find(call => call[0] === 'connection')[1];
      connectionHandler(mockWs, mockRequest);

      expect(webSocketServer.clients.size).toBe(1);
      expect(mockWs.on).toHaveBeenCalledWith('message', expect.any(Function));
      expect(mockWs.on).toHaveBeenCalledWith('close', expect.any(Function));
      expect(mockWs.on).toHaveBeenCalledWith('error', expect.any(Function));
      expect(mockWs.on).toHaveBeenCalledWith('pong', expect.any(Function));
    });

    it('should send welcome message to new client', () => {
      const mockRequest = {
        socket: { remoteAddress: '127.0.0.1' },
        headers: { 'user-agent': 'test-client' }
      };

      const connectionHandler = mockWss.on.mock.calls.find(call => call[0] === 'connection')[1];
      connectionHandler(mockWs, mockRequest);

      expect(mockWs.send).toHaveBeenCalledWith(
        expect.stringContaining('"type":"connection"')
      );
    });
  });

  describe('handleClientMessage', () => {
    let clientId;

    beforeEach(async () => {
      await webSocketServer.initialize();
      
      // Add a mock client
      clientId = 'test_client_123';
      webSocketServer.clients.set(clientId, {
        id: clientId,
        ws: mockWs,
        subscriptions: new Set(),
        isAlive: true
      });
    });

    it('should handle subscribe message', () => {
      const subscribeMessage = JSON.stringify({
        type: 'subscribe',
        channel: 'conversation_updates'
      });

      webSocketServer.handleClientMessage(clientId, Buffer.from(subscribeMessage));

      const client = webSocketServer.clients.get(clientId);
      expect(client.subscriptions.has('conversation_updates')).toBe(true);
      expect(mockWs.send).toHaveBeenCalledWith(
        expect.stringContaining('"type":"subscription_confirmed"')
      );
    });

    it('should handle unsubscribe message', () => {
      // First subscribe
      const client = webSocketServer.clients.get(clientId);
      client.subscriptions.add('conversation_updates');

      const unsubscribeMessage = JSON.stringify({
        type: 'unsubscribe',
        channel: 'conversation_updates'
      });

      webSocketServer.handleClientMessage(clientId, Buffer.from(unsubscribeMessage));

      expect(client.subscriptions.has('conversation_updates')).toBe(false);
    });

    it('should handle ping message', () => {
      const pingMessage = JSON.stringify({ type: 'ping' });

      webSocketServer.handleClientMessage(clientId, Buffer.from(pingMessage));

      expect(mockWs.send).toHaveBeenCalledWith(
        expect.stringContaining('"type":"pong"')
      );
    });

    it('should handle malformed JSON gracefully', () => {
      const invalidMessage = 'invalid json{';

      expect(() => {
        webSocketServer.handleClientMessage(clientId, Buffer.from(invalidMessage));
      }).not.toThrow();
    });
  });

  describe('broadcast', () => {
    beforeEach(async () => {
      await webSocketServer.initialize();
      
      // Add mock clients
      webSocketServer.clients.set('client1', {
        id: 'client1',
        ws: { ...mockWs, readyState: WebSocket.OPEN },
        subscriptions: new Set(['conversation_updates'])
      });
      
      webSocketServer.clients.set('client2', {
        id: 'client2',
        // Shares mockWs.send with client1 (via the spread) so the broadcast
        // assertions can count total deliveries. Overriding it with a separate
        // jest.fn() here made "broadcast to all clients" unprovable: mockWs.send
        // could only ever record client1's delivery.
        ws: { ...mockWs, readyState: WebSocket.OPEN },
        subscriptions: new Set(['data_updates'])
      });
    });

    it('should broadcast to all clients when no channel specified', () => {
      const message = { type: 'test_message', data: 'test' };

      webSocketServer.broadcast(message);

      expect(mockWs.send).toHaveBeenCalledTimes(2);
    });

    it('should broadcast only to subscribed clients when channel specified', () => {
      const message = { type: 'conversation_state_change', data: 'test' };

      webSocketServer.broadcast(message, 'conversation_updates');

      // Only client1 should receive the message (subscribed to conversation_updates)
      expect(mockWs.send).toHaveBeenCalledTimes(1);
    });

    it('should handle send errors gracefully', () => {
      const errorWs = {
        ...mockWs,
        send: jest.fn().mockImplementation(() => {
          throw new Error('Send failed');
        }),
        readyState: WebSocket.OPEN
      };

      webSocketServer.clients.set('error_client', {
        id: 'error_client',
        ws: errorWs,
        subscriptions: new Set()
      });

      const message = { type: 'test_message', data: 'test' };

      expect(() => {
        webSocketServer.broadcast(message);
      }).not.toThrow();

      // Error client should be removed
      expect(webSocketServer.clients.has('error_client')).toBe(false);
    });
  });

  describe('notification methods', () => {
    beforeEach(async () => {
      await webSocketServer.initialize();
      jest.spyOn(webSocketServer, 'broadcast');
    });

    it('should notify conversation state change', () => {
      webSocketServer.notifyConversationStateChange('conv_123', 'active', { project: 'test' });

      expect(webSocketServer.broadcast).toHaveBeenCalledWith(
        {
          type: 'conversation_state_change',
          data: {
            conversationId: 'conv_123',
            newState: 'active',
            project: 'test'
          }
        },
        'conversation_updates'
      );
    });

    it('should notify data refresh', () => {
      const testData = { conversations: [], summary: {} };
      
      webSocketServer.notifyDataRefresh(testData);

      expect(webSocketServer.broadcast).toHaveBeenCalledWith(
        {
          type: 'data_refresh',
          data: testData
        },
        'data_updates'
      );
    });

    it('should notify system status', () => {
      const status = { message: 'System healthy', level: 'info' };
      
      webSocketServer.notifySystemStatus(status);

      expect(webSocketServer.broadcast).toHaveBeenCalledWith(
        {
          type: 'system_status',
          data: status
        },
        'system_updates'
      );
    });
  });

  describe('heartbeat mechanism', () => {
    beforeEach(async () => {
      jest.useFakeTimers();
      await webSocketServer.initialize();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('should start heartbeat on initialization', () => {
      expect(webSocketServer.heartbeatInterval).not.toBeNull();
    });

    it('should ping clients and remove unresponsive ones', () => {
      // Add responsive client
      const responsiveWs = { ...mockWs, ping: jest.fn() };
      webSocketServer.clients.set('responsive', {
        id: 'responsive',
        ws: responsiveWs,
        isAlive: true
      });

      // Add unresponsive client
      const unresponsiveWs = { ...mockWs, terminate: jest.fn() };
      webSocketServer.clients.set('unresponsive', {
        id: 'unresponsive',
        ws: unresponsiveWs,
        isAlive: false
      });

      // Trigger heartbeat
      jest.advanceTimersByTime(30000);

      expect(responsiveWs.ping).toHaveBeenCalled();
      expect(unresponsiveWs.terminate).toHaveBeenCalled();
      expect(webSocketServer.clients.has('unresponsive')).toBe(false);
    });
  });

  describe('getStats', () => {
    beforeEach(async () => {
      await webSocketServer.initialize();
    });

    it('should return server statistics', () => {
      // Add some mock clients
      webSocketServer.clients.set('client1', {
        id: 'client1',
        ip: '127.0.0.1',
        connectedAt: new Date(),
        subscriptions: new Set(['test']),
        isAlive: true
      });

      const stats = webSocketServer.getStats();

      expect(stats).toMatchObject({
        isRunning: true,
        clientCount: 1,
        queuedMessages: 0,
        clients: expect.arrayContaining([
          expect.objectContaining({
            id: 'client1',
            ip: '127.0.0.1',
            subscriptions: ['test'],
            isAlive: true
          })
        ])
      });
    });
  });

  describe('close', () => {
    beforeEach(async () => {
      await webSocketServer.initialize();
    });

    it('should close all connections and stop server', async () => {
      // Add a mock client
      webSocketServer.clients.set('client1', {
        id: 'client1',
        ws: mockWs
      });

      await webSocketServer.close();

      expect(mockWs.close).toHaveBeenCalledWith(1000, 'Server shutting down');
      expect(mockWss.close).toHaveBeenCalled();
      expect(webSocketServer.isRunning).toBe(false);
      expect(webSocketServer.clients.size).toBe(0);
    });
  });
});