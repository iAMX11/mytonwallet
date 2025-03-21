import type { Connector } from '../../util/PostMessageConnector';

import { IS_CORE_WALLET } from '../../config';
import { EventEmitter } from '../../util/callbacks';

declare global {
  interface Window {
    tonProtocolVersion: 1;
    ton: TonProvider;
    myTonWallet: TonProvider;
    tonWallet: TonProvider;
  }
}

type Methods =
  'ton_getBalance'
  | 'ton_requestAccounts'
  | 'ton_requestWallets'
  | 'ton_sendTransaction'
  | 'ton_rawSign';

export class TonProvider extends EventEmitter {
  public isMyTonWallet = !IS_CORE_WALLET;

  public isTonWallet = true; // Native extension legacy requirement

  constructor(private apiConnector: Connector) {
    super();
  }

  destroy() {
    this.apiConnector.destroy();
  }

  // Prefixes is the native extension legacy requirement
  send(name: Methods, args: any[] = []) {
    return this.apiConnector.request({ name, args });
  }
}

export function initTonProvider(apiConnector: Connector) {
  const tonProvider = new TonProvider(apiConnector);

  if (window.ton) {
    try {
      window.ton.destroy();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.log(err);
    }
  }

  window.tonProtocolVersion = 1;
  window.ton = tonProvider;
  if (IS_CORE_WALLET) {
    window.tonWallet = tonProvider;
  } else {
    window.myTonWallet = tonProvider;
  }
  window.dispatchEvent(new Event('tonready'));

  return tonProvider;
}
