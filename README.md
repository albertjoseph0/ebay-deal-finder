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
| `SEARCH_EXCLUSIONS` | *(see config cell)* | Terms to exclude from search |
| `CONDITION` | `Used` | eBay condition filter |
| `LLM_PRODUCT_GUIDANCE` | *(see config cell)* | Optional product-specific LLM evaluation tips |
| `MIN_Z_SCORE` | `-1.0` | Statistical deal threshold when variance is usable |
| `MIN_MARKET_SAMPLE` | `20` | Minimum listing sample required |
| `FALLBACK_DISCOUNT_RATE` | `0.10` | Discount threshold used when std dev is too small |
| `EBAY_FEE_RATE` | `0.13` | Estimated seller fee rate |
| `MAX_LLM_CALLS` | `200` | Maximum deals sent to LLM evaluation |
| `MAX_IMAGES_PER_LISTING` | `5` | Images per listing for LLM |
| `API_TIMEOUT_S` | `15` | HTTP timeout for eBay calls |
| `LLM_TIMEOUT_S` | `45` | Timeout for Azure OpenAI calls |
| `BUYER_COUNTRY` | `US` | Buyer's country code (improves shipping estimates) |
| `BUYER_POSTAL_CODE` | *(empty)* | Buyer's postal/ZIP code (enables accurate CALCULATED shipping) |

## Searching for Different Products

The notebook is designed to work with **any product**. To switch products, update the
`PRODUCT CONFIGURATION` section at the top of the config cell (cell 2):

### Example: TI-84 Plus CE Graphing Calculator
```python
SEARCH_QUERY = '"TI-84 Plus CE" graphing calculator'
SEARCH_EXCLUSIONS = '-charger -case -cable -cover -"parts only" -"for parts" -stand -holder -skin'
CONDITION = "Used"
LLM_PRODUCT_GUIDANCE = "Check that the screen powers on with no dead pixels. Color screen CE models are the target."
```

### Example: AirPods Pro (2nd Generation)
```python
SEARCH_QUERY = '"AirPods Pro" 2nd generation'
SEARCH_EXCLUSIONS = '-case -tips -ear -cushion -"left only" -"right only" -"parts only" -"for parts" -skin'
CONDITION = "Used"
LLM_PRODUCT_GUIDANCE = "Verify both earbuds and charging case are included. Check battery health if mentioned. Ensure genuine Apple, not knockoffs."
```

### Example: Dyson V15 Detect Vacuum
```python
SEARCH_QUERY = '"Dyson V15" detect vacuum'
SEARCH_EXCLUSIONS = '-filter -brush -head -hose -"parts only" -"for parts" -attachment -wand -bin'
CONDITION = "Used"
LLM_PRODUCT_GUIDANCE = "Confirm all attachments are included. Check suction power claims. Verify battery holds charge."
```

### Tips
- **`SEARCH_QUERY`**: Use eBay-style quotes for exact phrases. Test your query on ebay.com first.
- **`SEARCH_EXCLUSIONS`**: Prefix each unwanted term with `-`. Focus on accessories and parts that share keywords with the main product.
- **`CONDITION`**: Don't mix conditions (e.g., "New" + "Used") — it skews the statistical analysis.
- **`LLM_PRODUCT_GUIDANCE`**: Optional. Tell the LLM what to look for when evaluating this specific product. Leave empty (`""`) to use default evaluation only.

## Notes

- **Shipping-aware pricing**: All statistics (median, mean, IQR), deal scoring (z-score, discount %), and profit calculations use **total cost** (item price + shipping). The SHIP and TOTAL columns in the results table show the breakdown.
- Setting `BUYER_POSTAL_CODE` sends the `X-EBAY-C-ENDUSERCTX` header to eBay, which returns accurate shipping estimates for CALCULATED-shipping listings. Without it, some shipping costs may show as `?`.
- The notebook intentionally does **not** cap sold-quantity enrichment breadth.
- LLM evaluation is optional; without Azure config, recommendations fall back to price-signal logic.
- The shared `getItem` cache avoids duplicate listing-detail requests across enrichment and LLM analysis.
