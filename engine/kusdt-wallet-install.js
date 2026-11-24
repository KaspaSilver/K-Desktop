// Installs engine/kusdt-wallet-bridge.js on the worker's global scope. Its own module, imported
// first by engine/kusdt-wallet-worker.js: ES modules run in import order, so the handlers exist
// before kusdt/kusdt-wallet.js reads `webkit.messageHandlers` and replaces `fetch`.

import { installKusdtWalletBridge } from "./kusdt-wallet-bridge.js";

export const bridge = installKusdtWalletBridge(globalThis);
