import axios from 'axios'

const api = axios.create({
  baseURL: '/api/v1',
  timeout: 90000,
})

export default api

// Dashboard
export const getDashboardSummary = () => api.get('/dashboard/summary').then(r => r.data)
export const getPnlChart = (range: string) => api.get(`/dashboard/pnl-chart?range=${range}`).then(r => r.data)
export const getTopStocks = () => api.get('/dashboard/top-stocks').then(r => r.data)
export const getPerformanceSplit = () => api.get('/dashboard/performance-split').then(r => r.data)

// Trades
export const getTrades = (date?: string) => api.get('/trades', { params: { date } }).then(r => r.data)
export const getTradeHistory = (params: Record<string, string | undefined>) =>
  api.get('/trades/history', { params }).then(r => r.data)

// Holdings
export const getHoldings = () => api.get('/holdings').then(r => r.data)
export const getAccountBalance = () => api.get('/holdings/balance').then(r => r.data)
export const refreshHoldings = () => api.post('/holdings/refresh').then(r => r.data)
export const syncHoldingsWithKiwoom = () => api.post('/holdings/sync').then(r => r.data)
export const getPendingBuys = () => api.get('/holdings/pending-buys').then(r => r.data)
export const toggleLongTerm = (stock_code: string) =>
  api.patch(`/holdings/${stock_code}/long-term`).then(r => r.data)
export const toggleManual = (stock_code: string) =>
  api.patch(`/holdings/${stock_code}/toggle-manual`).then(r => r.data)

// Signals
export const getSignals = (date?: string) => api.get('/signals', { params: { date } }).then(r => r.data)
export const runSignals = () => api.post('/signals/run').then(r => r.data)

// Strategy
export const getStrategy = () => api.get('/strategy').then(r => r.data)
export const updateStrategy = (data: Record<string, unknown>) => api.put('/strategy', data).then(r => r.data)
export const toggleAutoTrade = () => api.post('/strategy/toggle').then(r => r.data)
export const initStrategy = () => api.post('/strategy/init').then(r => r.data)

// Watchlist
export const getWatchlist = () => api.get('/watchlist').then(r => r.data)
export const addWatchlist = (data: Record<string, unknown>) => api.post('/watchlist', data).then(r => r.data)
export const updateWatchlist = (id: number, data: Record<string, unknown>) => api.patch(`/watchlist/${id}`, data).then(r => r.data)
export const deleteWatchlist = (id: number) => api.delete(`/watchlist/${id}`).then(r => r.data)

// Backtest
export const runBacktest = (data: Record<string, unknown>) => api.post('/backtest/run', data).then(r => r.data)
export const listBacktests = () => api.get('/backtest').then(r => r.data)
export const getBacktest = (id: number) => api.get(`/backtest/${id}`).then(r => r.data)
export const deleteBacktest = (id: number) => api.delete(`/backtest/${id}`).then(r => r.data)

// Portfolio (개인 보유 종목 - 자동매매와 별도)
export const getPortfolio = () => api.get('/portfolio').then(r => r.data)
export const addPortfolioHolding = (data: Record<string, unknown>) => api.post('/portfolio', data).then(r => r.data)
export const updatePortfolioHolding = (id: number, data: Record<string, unknown>) => api.put(`/portfolio/${id}`, data).then(r => r.data)
export const deletePortfolioHolding = (id: number) => api.delete(`/portfolio/${id}`).then(r => r.data)
export const refreshPortfolioPrices = () => api.post('/portfolio/refresh-prices').then(r => r.data)
export const syncFromToss = () => api.post('/portfolio/sync-from-toss').then(r => r.data)
export const getTossAccounts = () => api.get('/portfolio/accounts').then(r => r.data)
export const getPortfolioTransactions = (stock_code?: string) => api.get('/portfolio/transactions', { params: { stock_code } }).then(r => r.data)
export const addPortfolioTransaction = (data: Record<string, unknown>) => api.post('/portfolio/transactions', data).then(r => r.data)

// News
export const getNews = (params?: Record<string, unknown>) => api.get('/news', { params }).then(r => r.data)
export const getSentimentSummary = (hours = 24) => api.get(`/news/sentiment/summary?hours=${hours}`).then(r => r.data)
export const getSentimentByStock = (hours = 24) => api.get(`/news/sentiment/by-stock?hours=${hours}`).then(r => r.data)
export const triggerNewsCollect = () => api.post('/news/collect').then(r => r.data)
export const analyzePendingNews = () => api.post('/news/analyze-pending').then(r => r.data)

// Models
export const getModels = () => api.get('/models').then(r => r.data)
export const getModelPerformance = (modelId: string, days = 30) => api.get(`/models/${modelId}/performance?days=${days}`).then(r => r.data)
export const getRecentSignals = (hours = 24, modelId = '') => api.get(`/models/signals/recent?hours=${hours}&model_id=${modelId}`).then(r => r.data)
export const toggleModel = (modelId: string) => api.patch(`/models/${modelId}/toggle`).then(r => r.data)
export const getModelStocks = (modelId: string) => api.get(`/models/${modelId}/stocks`).then(r => r.data)
export const updateModelStocks = (modelId: string, stocks: { code: string; name: string }[]) =>
  api.put(`/models/${modelId}/stocks`, { stocks }).then(r => r.data)

// Auto Trade
export const getAutoTradeLogs = (params?: Record<string, unknown>) => api.get('/auto-trade/logs', { params }).then(r => r.data)
export const getAutoTradeLogsByDate = (trade_date: string) => api.get('/auto-trade/logs', { params: { trade_date, limit: 500 } }).then(r => r.data)
export const getAutoTradeDailySummary = (days = 90) => api.get(`/auto-trade/daily-summary?days=${days}`).then(r => r.data)
export const getCycleLogs = () => api.get('/auto-trade/cycle-log').then(r => r.data)
export const getAutoTradeToday = () => api.get('/auto-trade/logs/today').then(r => r.data)
export const getAutoTradeStats = (days = 30) => api.get(`/auto-trade/stats?days=${days}`).then(r => r.data)
export const getMarketStatus = () => api.get('/auto-trade/market-status').then(r => r.data)
export const runAutoTradeNow = () => api.post('/auto-trade/run-now?force=true').then(r => r.data)
export const sendReportNow = () => api.post('/auto-trade/report/send-now').then(r => r.data)
export const getTradeMode = () => api.get('/auto-trade/mode').then(r => r.data)
export const setTradeMode = (real_trade: boolean) => api.post('/auto-trade/mode', { real_trade }).then(r => r.data)
export const getModelHitRate = (days = 30) => api.get(`/auto-trade/model-performance?days=${days}`).then(r => r.data)
export const getSignalPreview = () =>
  api.get('/auto-trade/signal-preview').then(r => r.data)
export const reconcileOrders = (trade_date?: string) =>
  api.post('/auto-trade/reconcile', null, { params: trade_date ? { trade_date } : undefined }).then(r => r.data)

// Telegram
export const saveModelWeights = (weights: Record<string, number>) =>
  api.post('/strategy/model-weights', { weights }).then(r => r.data)

export const getTelegramStatus = () => api.get('/telegram/status').then(r => r.data)
export const sendTelegramTest  = () => api.post('/telegram/test').then(r => r.data)
export const saveTelegramConfig = (bot_token: string, chat_id: string) =>
  api.post('/telegram/config', { bot_token, chat_id }).then(r => r.data)

// Stock Prices (일별 주가 이력)
export const getStockChart = (code: string, days = 90) =>
  api.get(`/stock-prices/${code}/chart?days=${days}`).then(r => r.data)
export const getStockCodes = () => api.get('/stock-prices/codes').then(r => r.data)
export const triggerBackfill = (trading_days = 90) =>
  api.post(`/stock-prices/backfill?trading_days=${trading_days}`).then(r => r.data)

// Stock Master (KOSPI/KOSDAQ 종목 검색)
export const searchStocks = (q: string, limit = 20) =>
  api.get('/stocks/search', { params: { q, limit } }).then(r => r.data as { stock_code: string; stock_name: string; market: string }[])
export const getStockMasterStatus = () => api.get('/stocks/status').then(r => r.data as { count: number; last_updated: string | null })
export const refreshStockMaster = () => api.post('/stocks/refresh').then(r => r.data)

// Account Debug (TR 검증)
export const getTrSpecs      = () => api.get('/account-debug/specs').then(r => r.data)
export const validateAllTrs  = () => api.get('/account-debug/validate-all').then(r => r.data)
export const validateTr      = (trId: string) => api.get(`/account-debug/validate/${trId}`).then(r => r.data)
export const validateTrDates = (trId: string, strt?: string, end?: string) =>
  api.get(`/account-debug/validate/${trId}/with-dates`, { params: { strt_dt: strt, end_dt: end } }).then(r => r.data)
export const getTrFields     = (trId: string) => api.get(`/account-debug/fields/${trId}`).then(r => r.data)

// Manual Buy Orders
export const getManualBuyOrders = () => api.get('/manual-buy').then(r => r.data)
export const createManualBuyOrder = (data: { stock_code: string; stock_name?: string; quantity?: number; budget?: number }) =>
  api.post('/manual-buy', data).then(r => r.data)
export const cancelManualBuyOrder = (id: number) => api.delete(`/manual-buy/${id}`).then(r => r.data)

// Telegram Logs
export const getTelegramLogs = (params?: { days?: number; msg_type?: string }) =>
  api.get('/telegram/logs', { params }).then(r => r.data)
export const runTelegramCommand = (text: string) =>
  api.post('/telegram/command', { text, source: 'web' }).then(r => r.data)
export const getTelegramCommandLogs = (params?: { days?: number; command_type?: string }) =>
  api.get('/telegram/command-logs', { params }).then(r => r.data)
export const getTelegramInbox = (limit = 100) =>
  api.get(`/telegram/inbox?limit=${limit}`).then(r => r.data)

// DART 공시
export const getDartList    = (params?: Record<string, unknown>) => api.get('/dart/list', { params }).then(r => r.data)
export const getDartStats   = () => api.get('/dart/stats').then(r => r.data)
export const collectDart    = () => api.post('/dart/collect').then(r => r.data)

// 수급 분석 (pykrx + FinanceDataReader)
export const getSupplyMarket    = () => api.get('/supply/market').then(r => r.data)
export const getSupplyStock     = (code: string, days = 5) => api.get(`/supply/stock/${code}?days=${days}`).then(r => r.data)
export const getSupplyWatchlist = (days = 5) => api.get(`/supply/watchlist?days=${days}`).then(r => r.data)

// Model Portfolio (수익률 분석)
export const getModelPortfolioAll = () => api.get('/model-portfolio').then(r => r.data)
export const getModelPortfolioByModel = (modelId: string) => api.get(`/model-portfolio/${modelId}`).then(r => r.data)
export const getModelPortfolioSummary = () => api.get('/model-portfolio/summary').then(r => r.data)
export const addModelPortfolioStock = (data: Record<string, unknown>) => api.post('/model-portfolio', data).then(r => r.data)
export const patchModelPortfolioStock = (id: number, data: Record<string, unknown>) => api.patch(`/model-portfolio/${id}`, data).then(r => r.data)
export const deleteModelPortfolioStock = (id: number) => api.delete(`/model-portfolio/${id}`).then(r => r.data)
export const refreshModelPortfolioPrices = () => api.post('/model-portfolio/refresh-prices').then(r => r.data)

// 일별 계좌 잔고 스냅샷
export const getAccountSnapshots = (days = 90) => api.get(`/account-snapshots/?days=${days}`).then(r => r.data)
export const saveAccountSnapshotNow = () => api.post('/account-snapshots/save').then(r => r.data)

// 종목별 매매 분석
export const getTradedStocks = () => api.get('/auto-trade/traded-stocks').then(r => r.data)
export const getStockAnalysisLogs = (params: {
  stock_code?: string; days?: number; action?: string; limit?: number
}) => api.get('/auto-trade/logs', { params: { ...params, limit: params.limit ?? 500 } }).then(r => r.data)

// 프리장 스캔
export const triggerPremarketScan = () =>
  api.post('/premarket/scan').then(r => r.data)
export const getPremarketToday = () =>
  api.get('/premarket/today').then(r => r.data)
export const getPremarketHistory = (days = 7, signal?: string) =>
  api.get('/premarket/history', { params: { days, signal } }).then(r => r.data)

// 상승 종목 분석 (파일럿)
export const collectRisingStocks = (params: {
  analysis_date?: string; min_change_pct?: number; max_stocks?: number; compute_vol_ratio?: boolean
}) => api.post('/rising-stocks/collect', null, { params }).then(r => r.data)

export const getRisingStocks = (params: {
  days?: number; date_from?: string; date_to?: string; market?: string;
  category?: string; min_change?: number; was_bought?: boolean; limit?: number
}) => api.get('/rising-stocks/', { params }).then(r => r.data)

export const getRisingStocksSummary = (days = 30) =>
  api.get('/rising-stocks/summary', { params: { days } }).then(r => r.data)

export const getRisingStocksDates = (days = 90) =>
  api.get('/rising-stocks/dates', { params: { days } }).then(r => r.data)
