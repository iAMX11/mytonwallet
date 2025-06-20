import type {
  ApiUpdate,
  CancellableCallback, OriginMessageData, OriginMessageEvent, WorkerMessageData,
} from './PostMessageConnector';

import { bigintReviver } from './bigint';
import { logDebugError } from './logs';

declare const self: WorkerGlobalScope;

const callbackState = new Map<string, CancellableCallback>();

type ApiConfig =
  // eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
  ((name: string, ...args: any[]) => any | [any, ArrayBuffer[]])
  | Record<string, AnyFunction>;
type SendToOrigin = (data: WorkerMessageData, transferables?: Transferable[]) => void;

export function createPostMessageInterface(
  api: ApiConfig,
  channel?: string,
  target: DedicatedWorkerGlobalScope | Worker = self as DedicatedWorkerGlobalScope,
  shouldIgnoreErrors?: boolean,
) {
  function sendToOrigin(data: WorkerMessageData, transferables?: Transferable[]) {
    data.channel = channel;

    if (transferables) {
      target.postMessage(data, transferables);
    } else {
      target.postMessage(data);
    }
  }

  if (!shouldIgnoreErrors) {
    handleErrors(sendToOrigin);
  }

  (target as DedicatedWorkerGlobalScope).addEventListener('message', (message: OriginMessageEvent) => {
    if (message.data?.channel === channel) {
      void onMessage(api, message.data, sendToOrigin);
    }
  });
}

export function createExtensionInterface(
  portName: string,
  api: ApiConfig,
  channel?: string,
  cleanUpdater?: (onUpdate: (update: ApiUpdate) => void) => void,
  withAutoInit = false,
) {
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== portName) {
      return;
    }

    const url = port.sender?.url;
    const origin = url ? new URL(url).origin : undefined;

    const dAppUpdater = (update: ApiUpdate) => {
      sendToOrigin({
        type: 'update',
        update,
      });
    };

    function sendToOrigin(data: WorkerMessageData) {
      data.channel = channel;
      const json = JSON.stringify(data);
      port.postMessage(json);
    }

    handleErrors(sendToOrigin);

    port.onMessage.addListener((data: OriginMessageData | string) => {
      if (typeof data === 'string') {
        data = JSON.parse(data, bigintReviver) as OriginMessageData;
      }
      if (data.channel === channel) {
        void onMessage(api, data, sendToOrigin, dAppUpdater, origin);
      }
    });

    port.onDisconnect.addListener(() => {
      cleanUpdater?.(dAppUpdater);
    });

    if (withAutoInit) {
      void onMessage(api, { type: 'init', name: 'init', args: [] }, sendToOrigin, dAppUpdater);
    }
  });
}

async function onMessage(
  api: ApiConfig,
  data: OriginMessageData,
  sendToOrigin: SendToOrigin,
  onUpdate?: (update: ApiUpdate) => void,
  origin?: string,
) {
  if (!onUpdate) {
    onUpdate = (update: ApiUpdate) => {
      sendToOrigin({
        type: 'update',
        update,
      });
    };
  }

  switch (data.type) {
    case 'init': {
      const { args } = data;
      const promise = typeof api === 'function'
        ? api('init', origin, onUpdate, ...args)
        : api.init?.(onUpdate, ...args);
      await promise;

      break;
    }
    case 'callMethod': {
      const {
        messageId, name, args, withCallback,
      } = data;
      try {
        // This method is probably from another worker
        if (typeof api !== 'function' && !api[name]) return;

        if (messageId && withCallback) {
          const callback = (...callbackArgs: any[]) => {
            const lastArg = callbackArgs[callbackArgs.length - 1];

            sendToOrigin({
              type: 'methodCallback',
              messageId,
              callbackArgs,
            }, isTransferable(lastArg) ? [lastArg] : undefined);
          };

          callbackState.set(messageId, callback);

          args.push(callback as never);
        }

        const response = typeof api === 'function'
          ? await api(name, origin, ...args)
          : await api[name](...args);
        const { arrayBuffer } = (typeof response === 'object' && response && 'arrayBuffer' in response) || {};

        if (messageId) {
          sendToOrigin(
            {
              type: 'methodResponse',
              messageId,
              response,
            },
            arrayBuffer ? [arrayBuffer] : undefined,
          );
        }
      } catch (err: any) {
        logDebugError(name, err);

        if (messageId) {
          sendToOrigin({
            type: 'methodResponse',
            messageId,
            error: { message: err.message },
          });
        }
      }

      if (messageId) {
        callbackState.delete(messageId);
      }

      break;
    }
    case 'cancelProgress': {
      const callback = callbackState.get(data.messageId);
      if (callback) {
        callback.isCanceled = true;
      }

      break;
    }
  }
}

function isTransferable(obj: any) {
  return obj instanceof ArrayBuffer || obj instanceof ImageBitmap;
}

function handleErrors(sendToOrigin: SendToOrigin) {
  self.onerror = (e) => {
    const message = e.error?.message || 'Uncaught exception in worker';
    logDebugError(message, e.error);

    sendToOrigin({
      type: 'unhandledError',
      error: {
        message,
        stack: e.error?.stack,
      },
    });
  };

  self.addEventListener('unhandledrejection', (e) => {
    const message = e.reason?.message || 'Unhandled rejection in worker';
    logDebugError(message, e.reason);

    sendToOrigin({
      type: 'unhandledError',
      error: {
        message,
        stack: e.reason?.stack,
      },
    });
  });
}
