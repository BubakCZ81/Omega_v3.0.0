import datetime
import json
import math
import subprocess
import sys

try:
    import MetaTrader5 as mt5
except ImportError:
    mt5 = None


TIMEFRAMES = {
    "M1": "TIMEFRAME_M1",
    "M2": "TIMEFRAME_M2",
    "M3": "TIMEFRAME_M3",
    "M4": "TIMEFRAME_M4",
    "M5": "TIMEFRAME_M5",
    "M6": "TIMEFRAME_M6",
    "M10": "TIMEFRAME_M10",
    "M12": "TIMEFRAME_M12",
    "M15": "TIMEFRAME_M15",
    "M20": "TIMEFRAME_M20",
    "M30": "TIMEFRAME_M30",
    "H1": "TIMEFRAME_H1",
    "H2": "TIMEFRAME_H2",
    "H3": "TIMEFRAME_H3",
    "H4": "TIMEFRAME_H4",
    "H6": "TIMEFRAME_H6",
    "H8": "TIMEFRAME_H8",
    "H12": "TIMEFRAME_H12",
    "D1": "TIMEFRAME_D1",
    "W1": "TIMEFRAME_W1",
    "MN1": "TIMEFRAME_MN1",
}


def require_mt5():
    if mt5 is None:
        raise RuntimeError(
            "The MetaTrader5 Python package is not installed for this Python. "
            "Install 64-bit Python 3.10–3.14, then run: python -m pip install MetaTrader5"
        )


def require_connected_terminal():
    require_mt5()
    terminal = mt5.terminal_info()
    if terminal is None or not terminal.connected:
        raise RuntimeError("MetaTrader is not connected. Connect to a broker in the MT5 Feed panel first.")


def find_open_terminal():
    if sys.platform != "win32":
        return None

    command = (
        "Get-Process -Name terminal64 -ErrorAction SilentlyContinue "
        "| Sort-Object StartTime -Descending "
        "| Select-Object -First 1 -ExpandProperty Path"
    )
    try:
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise RuntimeError(f"Could not locate the open MetaTrader terminal: {error}") from error
    if result.returncode != 0:
        detail = result.stderr.strip()
        suffix = f" {detail}" if detail else ""
        raise RuntimeError(f"Could not locate the open MetaTrader terminal.{suffix}")
    terminal_path = result.stdout.strip()
    if not terminal_path:
        raise RuntimeError(
            "No open MetaTrader 5 terminal was found. Open terminal64.exe, sign in to your broker, and retry."
        )
    return terminal_path


def serialize_symbols():
    symbols = mt5.symbols_get()
    if symbols is None:
        raise RuntimeError(f"Could not read MetaTrader symbols: {mt5.last_error()}")
    return [
        {
            "ticker": symbol.name,
            "description": symbol.description or symbol.name,
            "path": symbol.path or "",
            "digits": int(symbol.digits),
            "point": float(symbol.point),
            "currencyBase": symbol.currency_base or "",
            "currencyProfit": symbol.currency_profit or "",
            "tradeContractSize": float(getattr(symbol, "trade_contract_size", 0) or 0),
            "tickValue": float(getattr(symbol, "trade_tick_value", 0) or 0),
        }
        for symbol in symbols
        if symbol.name
    ]


def serialize_info(ticker):
    info = mt5.symbol_info(ticker)
    if info is None:
        return None
    return {
        "ticker": info.name,
        "description": info.description or info.name,
        "path": info.path or "",
        "digits": int(info.digits),
        "point": float(info.point),
        "currencyBase": info.currency_base or "",
        "currencyProfit": info.currency_profit or "",
        "tradeContractSize": float(getattr(info, "trade_contract_size", 0) or 0),
        "tickValue": float(getattr(info, "trade_tick_value", 0) or 0),
    }


def serialize_bar(row):
    return {
        "time": int(row["time"]) * 1000,
        "open": float(row["open"]),
        "high": float(row["high"]),
        "low": float(row["low"]),
        "close": float(row["close"]),
        "volume": float(row["real_volume"]),
    }


def get_bars(request):
    ticker = request["ticker"]
    timeframe_name = request["timeframe"]
    timeframe = getattr(mt5, TIMEFRAMES.get(timeframe_name, ""), None)
    if timeframe is None:
        raise RuntimeError(f"MetaTrader does not support timeframe {timeframe_name}.")
    if mt5.symbol_info(ticker) is None:
        raise RuntimeError(f"MetaTrader does not recognize symbol {ticker}.")
    if not mt5.symbol_select(ticker, True):
        raise RuntimeError(f"Could not select {ticker} in MetaTrader: {mt5.last_error()}")

    range_value = request.get("range") or {}
    limit = min(max(int(range_value.get("limit", 1000)), 1), 50000)
    start = range_value.get("from")
    end = range_value.get("to")
    if start is not None:
        start_time = datetime.datetime.fromtimestamp(float(start) / 1000, datetime.timezone.utc)
        end_time = (
            datetime.datetime.fromtimestamp(float(end) / 1000, datetime.timezone.utc)
            if end is not None
            else datetime.datetime.now(datetime.timezone.utc)
        )
        rates = mt5.copy_rates_range(ticker, timeframe, start_time, end_time)
    else:
        rates = mt5.copy_rates_from_pos(ticker, timeframe, 0, limit)
    if rates is None:
        raise RuntimeError(f"Could not load {ticker} history from MetaTrader: {mt5.last_error()}")

    bars = [serialize_bar(row) for row in rates]
    bars.sort(key=lambda bar: bar["time"])
    return bars[-limit:]


def get_quote(request):
    require_connected_terminal()
    ticker_value = request.get("ticker")
    ticker = ticker_value.strip() if isinstance(ticker_value, str) else ""
    if not ticker or len(ticker) > 100:
        raise RuntimeError("Enter a valid MetaTrader symbol.")
    if mt5.symbol_info(ticker) is None:
        raise RuntimeError(f"MetaTrader does not recognize symbol {ticker}.")
    if not mt5.symbol_select(ticker, True):
        raise RuntimeError(f"Could not select {ticker} in MetaTrader: {mt5.last_error()}")
    tick = mt5.symbol_info_tick(ticker)
    if tick is None:
        raise RuntimeError(f"Could not read the latest {ticker} tick from MetaTrader: {mt5.last_error()}")
    bid = float(tick.bid)
    ask = float(tick.ask)
    if not math.isfinite(bid) or not math.isfinite(ask) or bid <= 0 or ask < bid:
        raise RuntimeError(f"MetaTrader returned an invalid bid/ask tick for {ticker}.")
    return {"bid": bid, "ask": ask}


def get_ticks(request):
    require_connected_terminal()
    ticker_value = request.get("ticker")
    ticker = ticker_value.strip() if isinstance(ticker_value, str) else ""
    if not ticker or len(ticker) > 100:
        raise RuntimeError("Enter a valid MetaTrader symbol.")
    if mt5.symbol_info(ticker) is None:
        raise RuntimeError(f"MetaTrader does not recognize symbol {ticker}.")
    if not mt5.symbol_select(ticker, True):
        raise RuntimeError(f"Could not select {ticker} in MetaTrader: {mt5.last_error()}")

    from_msc = request.get("fromMsc")
    if not isinstance(from_msc, (int, float)) or not math.isfinite(from_msc) or from_msc < 0:
        raise RuntimeError("Enter a valid MetaTrader tick start time.")
    count = min(max(int(request.get("limit", 1000)), 1), 10000)
    start_time = datetime.datetime.fromtimestamp(from_msc / 1000, datetime.timezone.utc)
    ticks = mt5.copy_ticks_from(ticker, start_time, mt5.COPY_TICKS_ALL, count)
    if ticks is None:
        raise RuntimeError(f"Could not read live {ticker} ticks from MetaTrader: {mt5.last_error()}")
    return [
        {
            "time": int(tick["time_msc"]),
            "bid": float(tick["bid"]),
            "ask": float(tick["ask"]),
            "last": float(tick["last"]),
            "volume": float(tick["volume"]),
            "volumeReal": float(tick["volume_real"]),
            "flags": int(tick["flags"]),
        }
        for tick in ticks
    ]


def get_market_book(request):
    require_connected_terminal()
    ticker_value = request.get("ticker")
    ticker = ticker_value.strip() if isinstance(ticker_value, str) else ""
    if not ticker or len(ticker) > 100:
        raise RuntimeError("Enter a valid MetaTrader symbol.")
    if mt5.symbol_info(ticker) is None:
        raise RuntimeError(f"MetaTrader does not recognize symbol {ticker}.")
    if not mt5.symbol_select(ticker, True):
        raise RuntimeError(f"Could not select {ticker} in MetaTrader: {mt5.last_error()}")
    if not mt5.market_book_add(ticker):
        raise RuntimeError(f"MetaTrader does not provide market depth for {ticker}: {mt5.last_error()}")
    try:
        entries = mt5.market_book_get(ticker)
        if entries is None:
            raise RuntimeError(f"Could not read {ticker} market depth from MetaTrader: {mt5.last_error()}")
        bid_types = {getattr(mt5, "BOOK_TYPE_BUY", -1), getattr(mt5, "BOOK_TYPE_BUY_MARKET", -2)}
        ask_types = {getattr(mt5, "BOOK_TYPE_SELL", -3), getattr(mt5, "BOOK_TYPE_SELL_MARKET", -4)}
        return [
            {
                "side": "bid" if entry.type in bid_types else "ask" if entry.type in ask_types else "unknown",
                "price": float(entry.price),
                "volume": float(entry.volume),
            }
            for entry in entries
        ]
    finally:
        mt5.market_book_release(ticker)


def handle(request):
    action = request.get("action")
    if action == "connect":
        require_mt5()
        terminal_path = find_open_terminal()
        initialized = mt5.initialize(path=terminal_path) if terminal_path else mt5.initialize()
        if not initialized:
            raise RuntimeError(f"Could not connect to the MetaTrader 5 terminal: {mt5.last_error()}")
        terminal = mt5.terminal_info()
        account = mt5.account_info()
        if terminal is None or not terminal.connected:
            mt5.shutdown()
            raise RuntimeError("MetaTrader terminal is offline. Sign in to your broker account in MT5 and retry.")
        return {
            "company": terminal.company or "",
            "terminal": terminal.name or "MetaTrader 5",
            "server": account.server if account else "",
            "symbols": serialize_symbols(),
        }
    if action == "symbols":
        require_mt5()
        return serialize_symbols()
    if action == "info":
        require_mt5()
        return serialize_info(request.get("ticker", ""))
    if action == "bars":
        require_mt5()
        return get_bars(request)
    if action == "quote":
        require_mt5()
        return get_quote(request)
    if action == "ticks":
        require_mt5()
        return get_ticks(request)
    if action == "market_book":
        require_mt5()
        return get_market_book(request)
    if action == "disconnect":
        if mt5 is not None:
            mt5.shutdown()
        return True
    raise RuntimeError("Unsupported MetaTrader bridge operation.")


for input_line in sys.stdin:
    request = {}
    try:
        request = json.loads(input_line)
        result = handle(request)
        response = {"id": request.get("id"), "ok": True, "result": result}
    except Exception as error:
        response = {"id": request.get("id") if isinstance(request, dict) else None, "ok": False, "error": str(error)}
    print(json.dumps(response, separators=(",", ":")), flush=True)
    if isinstance(request, dict) and request.get("action") == "disconnect":
        break
