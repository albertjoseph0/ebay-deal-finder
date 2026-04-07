# eBay Deal Finder

Find underpriced eBay listings by comparing against recent sold prices, with optional AI-powered listing evaluation.

## Prerequisites

- **Node.js 20.6+** (required for `node --env-file`)

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

4. **Lint**
   ```bash
   npm run lint
   ```

5. **Run it**
   ```bash
   npm start
   ```

## How It Works

1. Pulls ~90 days of **sold listings** via the Finding API
2. Removes outliers using **IQR filtering**
3. Calculates **median, standard deviation, and coefficient of variation (CV)**
4. Assesses **market quality** — is this product viable for arbitrage?
5. Searches **active fixed-price listings** below a z-score threshold *(or discount fallback when variance is too low)*
6. Enriches top deals with **sold quantity** data from Browse API
7. Ranks deals by **composite score** (price score + volume)
8. *(Optional)* Evaluates each deal with **Azure OpenAI GPT-5.4-mini** — analyzes listing photos, description, and seller quality

## LLM Evaluation (Optional)

When configured, the tool uses Azure OpenAI's vision model to evaluate each deal listing, similar to how you'd manually review listings:

- **Photo analysis** — checks images for screen damage, cracks, discoloration, missing parts
- **Description analysis** — looks for red flags ("as-is", "for parts", "not tested"), functional issues
- **Seller assessment** — grammar quality, disclosure transparency, feedback score
- **Completeness check** — cables, charger, case, manual, accessories

Each listing gets a verdict: 🟢 **BUY** | 🟡 **RISKY** | 🔴 **PASS** with confidence score and specific issues.

### Azure OpenAI Setup

1. Create an Azure OpenAI resource in the [Azure Portal](https://portal.azure.com)
2. Deploy a model (e.g. `gpt-5.4-mini`) in your resource
3. Add these to your `.env`:
   ```
   AZURE_OPENAI_ENDPOINT=https://your-resource.openai.azure.com
   AZURE_OPENAI_API_KEY=your-api-key
   AZURE_OPENAI_DEPLOYMENT=gpt-5.4-mini
   ```

If these variables are not set, LLM evaluation is skipped and the tool works normally.

## Configuration

Edit the constants at the top of `src/index.js`:

| Variable | Default | Description |
|----------|---------|-------------|
| `SEARCH_QUERY` | `'TI-84 Plus calculator'` | What to search for |
| `CONDITION` | `'Used'` | Item condition filter |
| `MIN_Z_SCORE` | `-1.0` | Z-score cutoff when market variance is usable |
| `MIN_SOLD_SAMPLE` | `20` | Minimum sold-listing sample required for reliable pricing |
| `FALLBACK_DISCOUNT_RATE` | `0.1` | Discount cutoff used when variance is too low for z-score |
| `EBAY_FEE_RATE` | `0.13` | eBay seller fee estimate (~13%) |
| `MAX_ENRICH` | `20` | How many deals to enrich with sold quantity |
| `MAX_LLM_EVAL` | `10` | How many deals to evaluate with LLM |
| `MAX_IMAGES_PER_LISTING` | `5` | Max images sent to LLM per listing |
