const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', message: 'Halal Trading Bot with Time Sync & recvWindow' });
});

// IP DETECTION ENDPOINT
app.get('/api/my-ip', async (req, res) => {
    try {
        const response = await axios.get('https://api.ipify.org');
        const ip = response.data;
        res.json({ 
            success: true, 
            ip: ip,
            message: 'Your Render server IP address'
        });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// Database (in-memory for active sessions)
const database = {
    sessions: {},
    activeTrades: {}
};

// Win streak tracker
const winStreaks = {};

// Rate limit tracker
const rateLimit = {
    lastRequestTime: 0,
    requestCount: 0,
    bannedUntil: 0,
    warningCount: 0
};

// AI Trading Engine
class AITradingEngine {
    constructor() {
        this.performance = { totalTrades: 0, successfulTrades: 0, totalProfit: 0 };
    }

    analyzeMarket(symbol, marketData, sessionId) {
        const { price = 0, volume24h = 0, priceChange24h = 0, high24h = 0, low24h = 0 } = marketData;
        
        const volumeRatio = volume24h / 1000000;
        const pricePosition = high24h > low24h ? (price - low24h) / (high24h - low24h) : 0.5;
        
        let confidence = 0.7;
        
        if (volumeRatio > 1.3) confidence += 0.15;
        if (volumeRatio > 1.8) confidence += 0.2;
        if (priceChange24h > 3) confidence += 0.2;
        if (priceChange24h > 7) confidence += 0.25;
        if (pricePosition < 0.35) confidence += 0.15;
        if (pricePosition > 0.65) confidence += 0.15;
        
        const currentStreak = winStreaks[sessionId] || 0;
        if (currentStreak > 0) {
            confidence += (currentStreak * 0.05);
        }
        
        confidence = Math.min(confidence, 0.98);
        
        const action = (pricePosition < 0.35 && priceChange24h > -3 && volumeRatio > 1.1) ? 'BUY' :
                      (pricePosition > 0.65 && priceChange24h > 3 && volumeRatio > 1.1) ? 'SELL' : 
                      (Math.random() > 0.2 ? 'BUY' : 'SELL');
        
        return { symbol, price, confidence, action };
    }

    calculatePositionSize(initialInvestment, currentProfit, targetProfit, timeElapsed, timeLimit, confidence, sessionId) {
        const timeRemaining = Math.max(0.1, (timeLimit - timeElapsed) / timeLimit);
        const remainingProfit = Math.max(1, targetProfit - currentProfit);
        
        let baseSize = Math.max(10, initialInvestment * 0.25);
        const timePressure = 1.5 / timeRemaining;
        const targetPressure = remainingProfit / (initialInvestment * 3);
        
        const currentStreak = winStreaks[sessionId] || 0;
        const winBonus = 1 + (currentStreak * 0.3);
        
        let positionSize = baseSize * timePressure * targetPressure * confidence * winBonus;
        const maxPosition = initialInvestment * 4;
        positionSize = Math.min(positionSize, maxPosition);
        positionSize = Math.max(positionSize, 10);
        
        return positionSize;
    }
}

// MULTI-ENDPOINT BINANCE API WITH TIME SYNC & recvWindow
class BinanceAPI {
    // Complete list of Binance endpoints for fallback strategy
    static endpoints = {
        base: [
            'https://api.binance.com',
            'https://api1.binance.com',
            'https://api2.binance.com',
            'https://api3.binance.com',
            'https://api4.binance.com'
        ],
        data: [
            'https://data.binance.com',
            'https://data1.binance.com',
            'https://data2.binance.com'
        ],
        testnet: ['https://testnet.binance.vision']
    };
    
    static async signRequest(queryString, secret) {
        return crypto
            .createHmac('sha256', secret)
            .update(queryString)
            .digest('hex');
    }

    static async delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // ENHANCED TIME SYNC WITH RETRY AND VALIDATION
    static async getServerTime() {
        // Try all base endpoints for time sync
        const allEndpoints = [
            'https://api.binance.com/api/v3/time',
            'https://api1.binance.com/api/v3/time',
            'https://api2.binance.com/api/v3/time',
            'https://api3.binance.com/api/v3/time',
            'https://api4.binance.com/api/v3/time',
            'https://data.binance.com/api/v3/time'
        ];
        
        for (const endpoint of allEndpoints) {
            try {
                const response = await axios.get(endpoint, { timeout: 3000 });
                const serverTime = response.data.serverTime;
                console.log(`✅ Time sync successful via: ${endpoint.split('/api')[0]}`);
                return serverTime;
            } catch (error) {
                console.log(`⚠️ Time endpoint failed: ${endpoint}`);
                continue;
            }
        }
        
        console.log('⚠️ All time endpoints failed, using local time');
        return Date.now();
    }

    // TIME SYNC WITH RETRY AND VALIDATION
    static async getServerTimeWithRetry() {
        const maxRetries = 3;
        
        for (let i = 0; i < maxRetries; i++) {
            const serverTime = await this.getServerTime();
            const localTime = Date.now();
            const diff = Math.abs(localTime - serverTime);
            
            console.log(`📡 Time sync attempt ${i + 1}: diff=${diff}ms`);
            
            if (diff < 5000) { // Within 5 seconds is acceptable
                console.log(`✅ Time synced successfully (diff=${diff}ms)`);
                return serverTime;
            }
            
            console.log(`⚠️ Time diff too large: ${diff}ms, retrying...`);
            await this.delay(1000);
        }
        
        console.log('⚠️ Using local time after retries');
        return Date.now();
    }

    static validateApiKey(apiKey) {
        if (!apiKey || apiKey.length < 10) {
            return { valid: false, reason: 'API key too short' };
        }
        // Check for spaces or line breaks in the key
        if (apiKey.includes(' ') || apiKey.includes('\n') || apiKey.includes('\r')) {
            return { valid: false, reason: 'API key contains spaces or line breaks' };
        }
        return { valid: true };
    }

    // CORE MULTI-ENDPOINT REQUEST METHOD WITH recvWindow
    static async makeRequest(endpoint, method, apiKey, secret, params = {}, useTestnet = false) {
        try {
            // Validate API key format first
            const keyValidation = this.validateApiKey(apiKey);
            if (!keyValidation.valid) {
                throw new Error(`Invalid API key format: ${keyValidation.reason}`);
            }

            // Check if IP is banned
            if (rateLimit.bannedUntil > Date.now()) {
                const minutesLeft = Math.ceil((rateLimit.bannedUntil - Date.now()) / 60000);
                throw new Error(`⚠️ IP BANNED for ${minutesLeft} more minutes. Please wait.`);
            }

            // Rate limit protection: 2 seconds between requests
            const timeSinceLastRequest = Date.now() - rateLimit.lastRequestTime;
            if (timeSinceLastRequest < 2000) {
                await this.delay(2000 - timeSinceLastRequest);
            }

            // Get server time with retry
            const serverTime = await this.getServerTimeWithRetry();
            
            // CRITICAL FIX: Add recvWindow to handle time drift
            // recvWindow allows a 5-second buffer for timestamp differences
            const queryParams = { 
                ...params, 
                timestamp: serverTime,
                recvWindow: 5000  // Allow 5 seconds of time drift
            };
            
            const queryString = Object.keys(queryParams)
                .map(key => `${key}=${queryParams[key]}`)
                .join('&');
            
            const signature = await this.signRequest(queryString, secret);
            
            // Determine which endpoints to try
            let endpointsToTry = [];
            if (useTestnet) {
                endpointsToTry = this.endpoints.testnet;
            } else if (endpoint.includes('/api/v3/ticker') || endpoint.includes('/api/v3/time')) {
                // For public data, try data endpoints first
                endpointsToTry = [...this.endpoints.data, ...this.endpoints.base];
            } else {
                // For authenticated requests, try base endpoints
                endpointsToTry = this.endpoints.base;
            }
            
            let lastError = null;
            let successfulEndpoint = null;
            
            // Try each endpoint in sequence
            for (const baseUrl of endpointsToTry) {
                try {
                    const url = `${baseUrl}${endpoint}?${queryString}&signature=${signature}`;
                    console.log(`📡 Trying endpoint: ${baseUrl}`);
                    
                    const response = await axios({
                        method,
                        url,
                        headers: { 'X-MBX-APIKEY': apiKey.trim() },
                        timeout: 10000
                    });
                    
                    // Success! Log which endpoint worked
                    successfulEndpoint = baseUrl;
                    console.log(`✅ Successfully connected via: ${baseUrl}`);
                    
                    rateLimit.lastRequestTime = Date.now();
                    rateLimit.requestCount++;
                    
                    // Check rate limit headers
                    const usedWeight = response.headers['x-mbx-used-weight-1m'];
                    if (usedWeight) {
                        const weight = parseInt(usedWeight);
                        console.log(`📊 Rate limit weight: ${weight}/1200`);
                        
                        if (weight > 1000) {
                            rateLimit.warningCount++;
                            if (rateLimit.warningCount >= 3) {
                                console.log('⚠️ Approaching rate limit! Waiting 60 seconds...');
                                await this.delay(60000);
                                rateLimit.warningCount = 0;
                            }
                        } else {
                            rateLimit.warningCount = 0;
                        }
                    }
                    
                    // Attach the successful endpoint to response data for debugging
                    response.data._usedEndpoint = baseUrl;
                    return response.data;
                    
                } catch (err) {
                    lastError = err;
                    const status = err.response?.status;
                    const errorMsg = err.response?.data?.msg || err.message;
                    const errorCode = err.response?.data?.code;
                    
                    console.log(`⚠️ Endpoint ${baseUrl} failed: ${status} - ${errorMsg}`);
                    
                    // If it's a 451 location error, try next endpoint
                    if (status === 451) {
                        console.log(`📍 Location restriction on ${baseUrl}, trying next...`);
                        continue;
                    }
                    
                    // If it's a timestamp error (-1021), try next endpoint
                    if (errorCode === -1021) {
                        console.log(`⏰ Timestamp error on ${baseUrl}, trying next endpoint...`);
                        continue;
                    }
                    
                    // If it's a 418 (banned) or 429 (rate limit), stop trying
                    if (status === 418 || status === 429) {
                        throw err;
                    }
                    
                    await this.delay(500);
                }
            }
            
            // If we get here, all endpoints failed
            console.error('🔴 All endpoints failed for this request');
            throw lastError || new Error('All Binance API endpoints failed');
            
        } catch (error) {
            // Handle specific error codes
            if (error.response) {
                const status = error.response.status;
                const data = error.response.data;
                const errorCode = data.code;
                
                console.error('🔴 Binance API Error Details:', {
                    status: status,
                    code: errorCode,
                    message: data.msg,
                    endpoint: endpoint
                });
                
                // Handle timestamp error specifically
                if (errorCode === -1021) {
                    console.log('⏰ TIMESTAMP ERROR: Server time out of sync');
                    console.log('   Retrying with new time sync...');
                    await this.delay(1000);
                    throw new Error('Timestamp error - time synced, please retry');
                }
                
                // Handle rate limit
                if (status === 429) {
                    rateLimit.warningCount++;
                    console.log('⛔ RATE LIMIT HIT! Waiting 60 seconds...');
                    await this.delay(60000);
                    throw new Error('Rate limit exceeded. Please slow down.');
                }
                
                // Handle IP ban
                if (status === 418) {
                    const banTimeMatch = data.msg?.match(/\d+/);
                    if (banTimeMatch) {
                        rateLimit.bannedUntil = parseInt(banTimeMatch[0]);
                        const banDate = new Date(parseInt(banTimeMatch[0])).toLocaleString();
                        console.log(`🚫 IP BANNED until ${banDate}`);
                    }
                    throw new Error(`IP BANNED: ${data.msg || 'Too many requests'}`);
                }
                
                // Handle location restriction
                if (status === 451) {
                    throw new Error(`LOCATION RESTRICTED: Your server IP is blocked. Use Testnet mode or a VPS in allowed region.`);
                }
                
                // Handle invalid API key
                if (errorCode === -2014 || errorCode === -2015) {
                    throw new Error('Invalid API key format or permissions. Check your Binance API settings and ensure "Spot & Margin Trading" is enabled.');
                }
                
                if (data.msg) {
                    throw new Error(`Binance Error ${errorCode}: ${data.msg}`);
                }
            }
            
            throw error;
        }
    }

    static async getAccountBalance(apiKey, secret, useTestnet = false) {
        try {
            const data = await this.makeRequest('/api/v3/account', 'GET', apiKey, secret, {}, useTestnet);
            const usdtBalance = data.balances.find(b => b.asset === 'USDT');
            return {
                success: true,
                free: parseFloat(usdtBalance?.free || 0),
                locked: parseFloat(usdtBalance?.locked || 0),
                total: parseFloat(usdtBalance?.free || 0) + parseFloat(usdtBalance?.locked || 0),
                endpoint: data._usedEndpoint
            };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    static async getTicker(symbol, useTestnet = false) {
        try {
            const data = await this.makeRequest('/api/v3/ticker/24hr', 'GET', 'dummy', 'dummy', { symbol }, useTestnet);
            return {
                success: true,
                data: data,
                endpoint: data._usedEndpoint
            };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    static async placeMarketOrder(apiKey, secret, symbol, side, quoteOrderQty, useTestnet = false) {
        try {
            const orderData = await this.makeRequest('/api/v3/order', 'POST', apiKey, secret, {
                symbol,
                side,
                type: 'MARKET',
                quoteOrderQty: quoteOrderQty.toFixed(2)
            }, useTestnet);
            
            let avgPrice = 0;
            let totalQty = 0;
            if (orderData.fills && orderData.fills.length > 0) {
                let totalValue = 0;
                orderData.fills.forEach(fill => {
                    totalValue += parseFloat(fill.price) * parseFloat(fill.qty);
                    totalQty += parseFloat(fill.qty);
                });
                avgPrice = totalValue / totalQty;
            }
            
            return {
                success: true,
                orderId: orderData.orderId,
                executedQty: parseFloat(orderData.executedQty),
                price: avgPrice || parseFloat(orderData.fills?.[0]?.price || 0),
                data: orderData,
                endpoint: orderData._usedEndpoint
            };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    static async verifyApiKey(apiKey, secret, useTestnet = false) {
        try {
            const keyValidation = this.validateApiKey(apiKey);
            if (!keyValidation.valid) {
                return { 
                    success: false, 
                    error: `Invalid format: ${keyValidation.reason}` 
                };
            }

            const data = await this.makeRequest('/api/v3/account', 'GET', apiKey, secret, {}, useTestnet);
            return {
                success: true,
                permissions: data.permissions,
                canTrade: data.canTrade,
                canWithdraw: data.canWithdraw,
                canDeposit: data.canDeposit,
                endpoint: data._usedEndpoint
            };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }
}

const aiEngine = new AITradingEngine();

// API Routes
app.post('/api/connect', async (req, res) => {
    const { email, accountNumber, apiKey, secretKey, accountType } = req.body;
    const useTestnet = accountType === 'testnet';
    
    if (!apiKey || !secretKey) {
        return res.status(400).json({
            success: false,
            message: 'API key and secret are required'
        });
    }
    
    // Clean the keys (remove any accidental whitespace/line breaks)
    const cleanApiKey = apiKey.trim().replace(/[\n\r]/g, '');
    const cleanSecretKey = secretKey.trim().replace(/[\n\r]/g, '');
    
    try {
        const verification = await BinanceAPI.verifyApiKey(cleanApiKey, cleanSecretKey, useTestnet);
        
        if (!verification.success) {
            return res.status(401).json({
                success: false,
                message: `API verification failed: ${verification.error}`
            });
        }
        
        if (!verification.canTrade && !useTestnet) {
            return res.status(403).json({
                success: false,
                message: 'API key does not have trading permission enabled. Please enable "Spot & Margin Trading" in Binance API settings.'
            });
        }
        
        const balance = await BinanceAPI.getAccountBalance(cleanApiKey, cleanSecretKey, useTestnet);
        
        const sessionId = 'session_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
        
        database.sessions[sessionId] = {
            id: sessionId,
            email,
            accountNumber,
            apiKey: cleanApiKey,
            secretKey: cleanSecretKey,
            connectedAt: new Date(),
            isActive: true,
            balance: balance.success ? balance.total : (useTestnet ? 10000 : 0),
            useTestnet
        };
        
        winStreaks[sessionId] = 0;
        
        const endpointInfo = balance.endpoint ? ` (via ${balance.endpoint})` : '';
        const message = useTestnet 
            ? `✅ Connected to Binance Testnet!${endpointInfo}`
            : `✅ Connected to REAL Binance! Balance: $${balance.success ? balance.total.toFixed(2) : '0'} USDT${endpointInfo}`;
        
        res.json({ 
            success: true, 
            sessionId,
            balance: balance.success ? balance.total : (useTestnet ? 10000 : 0),
            message,
            endpoint: balance.endpoint
        });
        
    } catch (error) {
        res.status(500).json({
            success: false,
            message: 'Connection failed: ' + error.message
        });
    }
});

app.post('/api/startTrading', async (req, res) => {
    const { sessionId, initialInvestment, targetProfit, timeLimit, riskLevel, tradingPairs } = req.body;
    
    const session = database.sessions[sessionId];
    if (!session) {
        return res.status(401).json({
            success: false,
            message: 'Invalid session'
        });
    }
    
    if (!session.useTestnet) {
        const balanceCheck = await BinanceAPI.getAccountBalance(session.apiKey, session.secretKey, false);
        if (!balanceCheck.success || balanceCheck.free < initialInvestment) {
            return res.status(400).json({
                success: false,
                message: `Insufficient balance. You have $${balanceCheck.free?.toFixed(2) || 0} USDT, need $${initialInvestment}`
            });
        }
    }
    
    const botId = 'bot_' + Date.now();
    database.activeTrades[botId] = {
        id: botId,
        sessionId,
        initialInvestment: parseFloat(initialInvestment) || 10,
        targetProfit: parseFloat(targetProfit) || 100,
        timeLimit: parseFloat(timeLimit) || 1,
        riskLevel: riskLevel || 'aggressive',
        tradingPairs: tradingPairs || ['BTCUSDT', 'ETHUSDT'],
        startedAt: new Date(),
        isRunning: true,
        currentProfit: 0,
        trades: [],
        lastTradeTime: Date.now()
    };
    
    session.activeBot = botId;
    winStreaks[sessionId] = 0;
    
    res.json({ 
        success: true, 
        botId, 
        message: `🔥 TRADING ACTIVE! Target: $${parseFloat(targetProfit).toLocaleString()}`,
        mode: session.useTestnet ? 'Testnet (Practice)' : 'Real Money'
    });
});

app.post('/api/stopTrading', (req, res) => {
    const { sessionId } = req.body;
    const session = database.sessions[sessionId];
    if (session?.activeBot) {
        session.activeBot = null;
    }
    res.json({ success: true, message: 'Trading stopped' });
});

// SAFE POLLING: 60 seconds minimum
app.post('/api/tradingUpdate', async (req, res) => {
    const { sessionId } = req.body;
    
    const session = database.sessions[sessionId];
    if (!session?.activeBot) {
        return res.json({ success: true, currentProfit: 0, newTrades: [] });
    }
    
    const trade = database.activeTrades[session.activeBot];
    if (!trade || !trade.isRunning) {
        return res.json({ success: true, currentProfit: trade?.currentProfit || 0, newTrades: [] });
    }
    
    const newTrades = [];
    const now = Date.now();
    
    const timeElapsed = (now - trade.startedAt) / (1000 * 60 * 60);
    const timeRemaining = Math.max(0, trade.timeLimit - timeElapsed);
    
    const timeSinceLastTrade = (now - (trade.lastTradeTime || 0)) / 1000;
    
    if (timeRemaining > 0 && timeSinceLastTrade >= 60) {
        const symbol = trade.tradingPairs[Math.floor(Math.random() * trade.tradingPairs.length)] || 'BTCUSDT';
        
        const tickerData = await BinanceAPI.getTicker(symbol, session.useTestnet);
        
        if (tickerData.success) {
            const marketPrice = parseFloat(tickerData.data.lastPrice);
            const marketData = {
                price: marketPrice,
                volume24h: parseFloat(tickerData.data.volume),
                priceChange24h: parseFloat(tickerData.data.priceChangePercent),
                high24h: parseFloat(tickerData.data.highPrice),
                low24h: parseFloat(tickerData.data.lowPrice)
            };
            
            const signal = aiEngine.analyzeMarket(symbol, marketData, sessionId);
            
            if (signal.action !== 'HOLD') {
                const positionSize = aiEngine.calculatePositionSize(
                    trade.initialInvestment,
                    trade.currentProfit,
                    trade.targetProfit,
                    timeElapsed,
                    trade.timeLimit,
                    signal.confidence,
                    sessionId
                );
                
                const orderResult = await BinanceAPI.placeMarketOrder(
                    session.apiKey,
                    session.secretKey,
                    symbol,
                    signal.action,
                    positionSize,
                    session.useTestnet
                );
                
                if (orderResult.success) {
                    const currentTicker = await BinanceAPI.getTicker(symbol, session.useTestnet);
                    const currentPrice = currentTicker.success ? parseFloat(currentTicker.data.lastPrice) : marketPrice;
                    const entryPrice = orderResult.price || marketPrice;
                    
                    let profit = 0;
                    if (signal.action === 'BUY') {
                        profit = (currentPrice - entryPrice) * orderResult.executedQty;
                    } else {
                        profit = (entryPrice - currentPrice) * orderResult.executedQty;
                    }
                    
                    if (profit > 0) {
                        winStreaks[sessionId] = (winStreaks[sessionId] || 0) + 1;
                    } else {
                        winStreaks[sessionId] = 0;
                    }
                    
                    trade.currentProfit += profit;
                    trade.lastTradeTime = now;
                    
                    newTrades.push({
                        symbol: symbol,
                        side: signal.action,
                        quantity: orderResult.executedQty.toFixed(6),
                        price: entryPrice.toFixed(2),
                        profit: profit,
                        size: '$' + positionSize.toFixed(2),
                        confidence: (signal.confidence * 100).toFixed(0) + '%',
                        winStreak: winStreaks[sessionId],
                        endpoint: orderResult.endpoint,
                        timestamp: new Date().toISOString()
                    });
                    
                    trade.trades.unshift(...newTrades);
                    
                    if (trade.currentProfit >= trade.targetProfit) {
                        trade.targetReached = true;
                        trade.isRunning = false;
                    }
                    
                    console.log(`📊 Trade: ${signal.action} $${positionSize.toFixed(2)} ${symbol} - Profit: $${profit.toFixed(2)} via ${orderResult.endpoint || 'unknown'}`);
                }
            }
        }
    }
    
    if (timeElapsed >= trade.timeLimit) {
        trade.timeExceeded = true;
        trade.isRunning = false;
    }
    
    if (trade.trades.length > 50) {
        trade.trades = trade.trades.slice(0, 50);
    }
    
    let balance = { free: session.useTestnet ? 10000 : 0 };
    if (!session.useTestnet) {
        const balanceData = await BinanceAPI.getAccountBalance(session.apiKey, session.secretKey, false);
        if (balanceData.success) {
            balance = balanceData;
        }
    }
    
    res.json({ 
        success: true, 
        currentProfit: trade.currentProfit || 0,
        timeRemaining: timeRemaining.toFixed(2),
        targetReached: trade.targetReached || false,
        timeExceeded: trade.timeExceeded || false,
        newTrades: newTrades,
        balance: balance.free,
        winStreak: winStreaks[sessionId] || 0
    });
});

app.post('/api/balance', async (req, res) => {
    const { sessionId } = req.body;
    
    const session = database.sessions[sessionId];
    if (!session) {
        return res.status(401).json({ success: false, message: 'Invalid session' });
    }
    
    const balance = await BinanceAPI.getAccountBalance(session.apiKey, session.secretKey, session.useTestnet);
    
    res.json({
        success: balance.success,
        balance: balance.success ? balance.free : 0,
        error: balance.error
    });
});

// Serve index.html
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log('\n' + '='.repeat(60));
    console.log('🌙 HALAL AI TRADING BOT - TIME SYNC & recvWindow VERSION');
    console.log('='.repeat(60));
    console.log(`✅ Server running on port: ${PORT}`);
    console.log(`✅ Time sync with retry: Active`);
    console.log(`✅ recvWindow: 5000ms (handles time drift)`);
    console.log(`✅ Multi-endpoint fallback: Active`);
    console.log(`✅ Rate limit protection: Enabled`);
    console.log(`✅ 60-second safe trading mode`);
    console.log('='.repeat(60) + '\n');
});
