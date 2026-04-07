# eBay Deal Finder

Find underpriced eBay listings by comparing against recent sold prices.

## Setup

1. **Get eBay API keys** at [developer.ebay.com](https://developer.ebay.com)
   - Create an account → Application Keys → Create a Production keyset

2. **Configure credentials**
   ```bash
   cp .env.example .env
   # Edit .env with your API keys
   ```

3. **Install dependencies**
   ```bash
   npm install
   ```

4. **Run it**
   ```bash
   npm start
   ```

## How It Works

1. Pulls ~90 days of **sold listings** via the Finding API
2. Calculates **median/average market price** by condition
3. Searches **active listings** priced below a threshold (default: 65% of median)
4. Shows potential **profit after eBay fees**

## Configuration

Edit the constants at the top of `src/index.js`:

| Variable | Default | Description |
|----------|---------|-------------|
| `SEARCH_QUERY` | `'TI-84 Plus calculator'` | What to search for |
| `CONDITION` | `'Used'` | Item condition filter |
| `DEAL_THRESHOLD` | `0.65` | Flag items at this % of median or lower |
| `EBAY_FEE_RATE` | `0.13` | eBay seller fee estimate (~13%) |
