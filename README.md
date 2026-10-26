# Omega 3.0.0

Omega is a Windows desktop charting and Pine Script development platform built
with Electron, TypeScript, and Vite.

## Install for traders

Traders install only the generated `Omega-Setup-<version>.exe`. The installer
contains Electron, the Broker SDK, all production dependencies, and the MT5
bridge. Node.js, npm, Rust, Python, and any source files are not required to
run Omega.

## Development only: run from source

Install Node.js 20 or newer. Then, from this directory:

```powershell
npm install
npm run desktop
```

Run the automated test suite (Node's test runner, no extra tooling):

```powershell
npm test
```

To create the self-contained Windows installer, run:

```powershell
npm run package:win
```

## Pine Editor AI

The AI assistant is available in the installed Electron app for Gemini, Groq,
OpenRouter, Anthropic, Cohere, DeepSeek, Mistral, and Together AI. API keys are
encrypted for the current Windows user with Windows Data Protection (DPAPI).
The assistant sends the prompt and current Pine script to the provider you
select. A browser preview does not have access to the desktop bridge or its
encrypted key store, so AI requests are intentionally unavailable there.

## cTrader market data

The installed Electron app can connect to cTrader accounts for read-only chart
history and live quotes. Create a cTrader Open API application and enter its
Client ID and Client Secret in the Broker panel. Configure the application's
redirect URL as `http://127.0.0.1:17863/ctrader/callback`. Omega opens cTrader's
official authorization page in the system browser; cTrader ID sign-in, including
Google, is available there when enabled for the account. Linked live and demo
accounts are listed after authorization.

The app encrypts the Open API credentials and tokens for the current Windows
user with DPAPI. Select an account, then choose a symbol and use **Use selected
symbol on chart** to load its history and live updates. The cTrader connection
requests accounts-only access and does not place trades.

MetaTrader 5 integration additionally requires a local MT5 terminal and a
compatible Python installation. The MT5 bridge is included under `electron/`
and is bundled with the Electron application.

## Trading scope

Paper trades and pending paper orders are local simulations. Alpaca, MetaTrader
5, and cTrader provide market data; the cTrader connection is read-only. This
project does not certify live-trading readiness.

## Local AI endpoints

In the Pine AI assistant's **Provider settings**, choose **Local OpenAI-compatible API**,
enter the server's localhost base URL (for example `http://127.0.0.1:1234/v1` for
LM Studio), select **Test endpoint & load models**, choose or enter a model ID,
and save. This supports local servers that expose OpenAI-compatible `/models`
and `/chat/completions` endpoints, such as LM Studio, llama.cpp, KoboldCpp, and
other compatible desktop servers. The endpoint must use plain HTTP on
`localhost`, `127.0.0.1`, or `[::1]`; remote URLs are rejected. An API key is
optional and, if supplied, is encrypted using Windows user storage. With this
provider selected and LuxAlgo MCP research disabled, Omega sends prompts only
to the configured local endpoint. Any separate web-search or tool capability
must be configured in the local model server itself.

The Pine AI assistant can optionally search the public LuxAlgo Library through
LuxAlgo's hosted MCP endpoint (`https://mcp.luxalgo.com/mcp`). Enable **Include
LuxAlgo Library research (MCP)** under the assistant prompt to add read-only
concept and indicator search results as context. This makes a request to
LuxAlgo and your selected AI provider; it does not connect cTrader or send
chart OHLC data to the MCP server. The integration does not sign in or expose
broker accounts, journal tools, or trade execution.
