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
2. Removes outliers using **IQR filtering**
3. Calculates **median, standard deviation, and coefficient of variation (CV)**
4. Assesses **market quality** — is this product viable for arbitrage?
5. Searches **active listings** priced below a z-score threshold
6. Ranks deals by **z-score** (how many std devs below fair value)

## Configuration

Edit the constants at the top of `src/index.js`:

| Variable | Default | Description |
|----------|---------|-------------|
| `SEARCH_QUERY` | `'TI-84 Plus calculator'` | What to search for |
| `CONDITION` | `'Used'` | Item condition filter |
| `MIN_Z_SCORE` | `-1.0` | Show listings at or below this z-score (1σ under median) |
| `EBAY_FEE_RATE` | `0.13` | eBay seller fee estimate (~13%) |
