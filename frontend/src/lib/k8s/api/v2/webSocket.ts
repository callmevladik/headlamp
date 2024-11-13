import { useEffect, useMemo } from 'react';
import { getUserIdFromLocalStorage } from '../../../../stateless';
import { KubeObjectInterface } from '../../KubeObject';
import { BASE_HTTP_URL } from './fetch';
import { KubeListUpdateEvent } from './KubeList';

// Constants for WebSocket connection
export const BASE_WS_URL = BASE_HTTP_URL.replace('http', 'ws');
/**
 * Multiplexer endpoint for WebSocket connections
 */
const MULTIPLEXER_ENDPOINT = 'wsMultiplexer';

// Message types for WebSocket communication
interface WebSocketMessage {
  /** Cluster ID */
  clusterId: string;
  /** API path */
  path: string;
  /** Query parameters */
  query: string;
  /** User ID */
  userId: string;
  /** Message type */
  type: 'REQUEST' | 'CLOSE' | 'COMPLETE';
}

/**
 * WebSocket manager to handle connections across the application
 */
export const WebSocketManager = {
  socket: null as WebSocket | null,
  connecting: false,
  listeners: new Map<string, Set<(data: any) => void>>(),
  // Track completed paths to avoid duplicate processing
  completedPaths: new Set<string>(),

  /**
   * Create a unique key for a connection
   */
  createKey(clusterId: string, path: string, query: string): string {
    return `${clusterId}:${path}:${query}`;
  },

  /**
   * Establish or return existing WebSocket connection
   */
  async connect(): Promise<WebSocket> {
    // Return existing connection if available
    if (this.socket?.readyState === WebSocket.OPEN) {
      return this.socket;
    }

    // Wait for existing connection attempt to complete
    if (this.connecting) {
      return new Promise(resolve => {
        const checkConnection = setInterval(() => {
          if (this.socket?.readyState === WebSocket.OPEN) {
            clearInterval(checkConnection);
            resolve(this.socket);
          }
        }, 100);
      });
    }

    this.connecting = true;
    const wsUrl = `${BASE_WS_URL}${MULTIPLEXER_ENDPOINT}`;

    return new Promise((resolve, reject) => {
      const socket = new WebSocket(wsUrl);

      socket.onopen = () => {
        this.socket = socket;
        this.connecting = false;
        resolve(socket);
      };

      socket.onmessage = (event: MessageEvent) => {
        this.handleWebSocketMessage(event);
      };

      socket.onerror = event => {
        console.error('WebSocket error:', event);
        this.connecting = false;
        reject(new Error('WebSocket connection failed'));
      };

      socket.onclose = () => {
        this.handleWebSocketClose();
      };
    });
  },

  /**
   * Handle incoming WebSocket messages
   */
  handleWebSocketMessage(event: MessageEvent): void {
    try {
      const data = JSON.parse(event.data);
      if (data.clusterId && data.path) {
        const key = this.createKey(data.clusterId, data.path, data.query || '');

        if (data.type === 'COMPLETE') {
          this.handleCompletionMessage(data, key);
          return;
        }

        if (this.completedPaths.has(key)) {
          return;
        }

        // Pass the actual update data to listeners
        const update = data.data ? JSON.parse(data.data) : data;
        this.listeners.get(key)?.forEach(listener => listener(update));
      }
    } catch (err) {
      console.error('Failed to parse WebSocket message:', err);
    }
  },

  /**
   * Handle COMPLETE type messages
   */
  handleCompletionMessage(data: any, key: string): void {
    this.completedPaths.add(key);
    if (this.socket?.readyState === WebSocket.OPEN) {
      const closeMsg: WebSocketMessage = {
        clusterId: data.clusterId,
        path: data.path,
        query: data.query || '',
        userId: data.userId || '',
        type: 'CLOSE',
      };
      this.socket.send(JSON.stringify(closeMsg));
    }
  },

  /**
   * Handle WebSocket connection close
   */
  handleWebSocketClose(): void {
    console.log('WebSocket closed, attempting reconnect...');
    this.socket = null;
    this.connecting = false;
    if (this.listeners.size > 0) {
      setTimeout(() => this.connect(), 1000);
    }
  },

  /**
   * Subscribe to WebSocket updates for a specific path
   */
  async subscribe(
    clusterId: string,
    path: string,
    query: string,
    onMessage: (data: any) => void
  ): Promise<() => void> {
    const key = this.createKey(clusterId, path, query);
    if (!this.listeners.has(key)) {
      this.listeners.set(key, new Set());
    }
    this.listeners.get(key)!.add(onMessage);

    const socket = await this.connect();
    const userId = getUserIdFromLocalStorage();

    const message: WebSocketMessage = {
      clusterId,
      path,
      query,
      userId: userId || '',
      type: 'REQUEST',
    };

    socket.send(JSON.stringify(message));

    return () => this.handleUnsubscribe(key, onMessage, userId, path, query);
  },

  /**
   * Handle unsubscribe cleanup
   */
  handleUnsubscribe(
    key: string,
    onMessage: (data: any) => void,
    userId: string | null,
    path: string,
    query: string
  ): void {
    const listeners = this.listeners.get(key);
    listeners?.delete(onMessage);

    if (listeners?.size === 0) {
      this.listeners.delete(key);
      this.completedPaths.delete(key);
      if (this.socket?.readyState === WebSocket.OPEN) {
        const [clusterId] = key.split(':');
        const closeMsg: WebSocketMessage = {
          clusterId,
          path,
          query,
          userId: userId || '',
          type: 'CLOSE',
        };
        this.socket.send(JSON.stringify(closeMsg));
      }
    }

    if (this.listeners.size === 0 && this.socket) {
      this.socket.close();
      this.socket = null;
    }
  },
};

/**
 * React hook for WebSocket subscription
 */
export function useWebSocket<T extends KubeObjectInterface>({
  url: createUrl,
  enabled = true,
  cluster = '',
  onMessage,
  onError,
}: {
  url: () => string;
  enabled?: boolean;
  cluster?: string;
  onMessage: (data: KubeListUpdateEvent<T>) => void;
  onError?: (error: Error) => void;
}) {
  const url = useMemo(() => (enabled ? createUrl() : ''), [enabled, createUrl]);

  useEffect(() => {
    if (!enabled || !url) return;

    const parsedUrl = new URL(url, BASE_WS_URL);
    let cleanup: (() => void) | undefined;

    WebSocketManager.subscribe(
      cluster,
      parsedUrl.pathname,
      parsedUrl.search.slice(1),
      (update: any) => {
        try {
          if (isKubeListUpdateEvent<T>(update)) {
            onMessage(update);
          }
        } catch (err) {
          console.error('Failed to process WebSocket message:', err);
          onError?.(err as Error);
        }
      }
    ).then(
      unsubscribe => {
        cleanup = unsubscribe;
      },
      error => {
        console.error('WebSocket subscription failed:', error);
        onError?.(error);
      }
    );

    return () => {
      cleanup?.();
    };
  }, [enabled, url, cluster, onMessage, onError]);
}

// Type guard moved inside the file
function isKubeListUpdateEvent<T extends KubeObjectInterface>(
  data: any
): data is KubeListUpdateEvent<T> {
  return (
    data &&
    typeof data === 'object' &&
    'type' in data &&
    'object' in data &&
    ['ADDED', 'MODIFIED', 'DELETED'].includes(data.type)
  );
}
