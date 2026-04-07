# eBay Deal Finder (Python Notebook)

Find underpriced eBay listings by analyzing active market price distribution, then optionally evaluating listings with Azure OpenAI vision.

## Prerequisites

- Python 3.10+
- Jupyter Notebook or JupyterLab

## Setup

1. Copy environment template:
   ```bash
   cp .env.example .env
   ```

2. Fill in `.env` with your eBay keys:
   - `EBAY_APP_ID`
   - `EBAY_CERT_ID`
   - Optional Azure OpenAI values for LLM evaluation:
     - `AZURE_OPENAI_ENDPOINT`
     - `AZURE_OPENAI_API_KEY`
     - `AZURE_OPENAI_DEPLOYMENT`

3. Install dependencies:
   ```bash
   python3 -m pip install requests python-dotenv openai notebook
   ```

4. Launch the notebook:
   ```bash
   jupyter notebook ebay_deal_finder.ipynb
   ```

## Notebook Workflow

Run cells top-to-bottom:

1. Imports + configuration
2. Shared helpers (stats, retries, ranking)
3. eBay API + shared item cache
4. Market sampling and analysis
5. Deal discovery and sold-quantity enrichment
6. Optional LLM evaluation
7. Final ranking and display
8. End-to-end pipeline execution
9. Deterministic sanity checks (no network)

## Key Configuration Variables

These are defined in the notebook config cell.

| Variable | Default | Description |
|---|---:|---|
| `SEARCH_QUERY` | `"TI-84 Plus CE" graphing calculator` | Search phrase |
| `CONDITION` | `Used` | eBay condition filter |
| `MIN_Z_SCORE` | `-1.0` | Statistical deal threshold when variance is usable |
| `MIN_MARKET_SAMPLE` | `20` | Minimum listing sample required |
| `FALLBACK_DISCOUNT_RATE` | `0.10` | Discount threshold used when std dev is too small |
| `EBAY_FEE_RATE` | `0.13` | Estimated seller fee rate |
| `MAX_LLM_CALLS` | `200` | Maximum deals sent to LLM evaluation |
| `MAX_IMAGES_PER_LISTING` | `5` | Images per listing for LLM |
| `API_TIMEOUT_S` | `15` | HTTP timeout for eBay calls |
| `LLM_TIMEOUT_S` | `45` | Timeout for Azure OpenAI calls |

## Notes

- The notebook intentionally does **not** cap sold-quantity enrichment breadth.
- LLM evaluation is optional; without Azure config, recommendations fall back to price-signal logic.
- The shared `getItem` cache avoids duplicate listing-detail requests across enrichment and LLM analysis.
