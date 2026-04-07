import eBayApi from 'ebay-api';
import { AzureOpenAI } from 'openai';

// ─── Configuration ──────────────────────────────────────────────
const SEARCH_QUERY = '"TI-84 Plus CE" graphing calculator';
const SEARCH_EXCLUSIONS = '-charger -case -cable -cover -emulator -software -cord -bag -pouch -dock -screen -protector -"parts only" -"for parts" -stand -holder -skin -sticker -keypad';
const CONDITION = 'Used';
const MIN_Z_SCORE = -1.0; // Show listings at or below 1 std dev under median
const EBAY_FEE_RATE = 0.13; // ~13% eBay seller fees
const RESULTS_PER_PAGE = 200;
const MAX_LLM_CALLS = 200; // Budget cap: LLM-evaluate the top N deals by composite score
const MAX_IMAGES_PER_LISTING = 5; // Max images to send to LLM per listing
const MIN_MARKET_SAMPLE = 20;
const MIN_STD_DEV = 0.01;
const FALLBACK_DISCOUNT_RATE = 0.1; // Used when market variance is too low for z-score
const API_TIMEOUT_MS = 15_000;
const LLM_TIMEOUT_MS = 45_000;
const API_MAX_RETRIES = 2;
const API_RETRY_BASE_DELAY_MS = 500;

// ─── Initialize eBay client from .env ───────────────────────────
const eBay = eBayApi.fromEnv();

// ─── Helpers ────────────────────────────────────────────────────
function median(numbers) {
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function average(numbers) {
  return numbers.reduce((a, b) => a + b, 0) / numbers.length;
}

function formatCurrency(n) {
  return `$${n.toFixed(2)}`;
}

function filterOutliers(prices) {
  const sorted = [...prices].sort((a, b) => a - b);
  const q1 = sorted[Math.floor(sorted.length * 0.25)];
  const q3 = sorted[Math.floor(sorted.length * 0.75)];
  const iqr = q3 - q1;
  const lower = q1 - 1.5 * iqr;
  const upper = q3 + 1.5 * iqr;

  const filtered = sorted.filter((p) => p >= lower && p <= upper);

  return {
    filtered,
    lower: Math.max(lower, 0),
    upper,
    removedCount: prices.length - filtered.length,
  };
}

function stdDev(numbers, mean) {
  const squaredDiffs = numbers.map((n) => (n - mean) ** 2);
  return Math.sqrt(squaredDiffs.reduce((a, b) => a + b, 0) / numbers.length);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

function withTimeout(promiseFactory, timeoutMs, label) {
  let timeoutHandle;
  const operationPromise = Promise.resolve().then(() => promiseFactory());

  const timeoutPromise = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([operationPromise, timeoutPromise]).finally(() => {
    clearTimeout(timeoutHandle);
  });
}

function isRetryableApiError(err) {
  const status =
    err?.meta?.res?.status ??
    err?.response?.status ??
    err?.statusCode ??
    err?.status;
  if (typeof status === 'number') {
    return status === 408 || status === 429 || status >= 500;
  }

  const msg = errorMessage(err).toLowerCase();
  return (
    msg.includes('timeout') ||
    msg.includes('timed out') ||
    msg.includes('network') ||
    msg.includes('econnreset') ||
    msg.includes('socket hang up')
  );
}

async function callApiWithRetry(
  label,
  promiseFactory,
  { timeoutMs = API_TIMEOUT_MS, maxRetries = API_MAX_RETRIES } = {}
) {
  let attempt = 0;

  while (true) {
    attempt++;
    try {
      return await withTimeout(promiseFactory, timeoutMs, label);
    } catch (err) {
      const shouldRetry = attempt <= maxRetries && isRetryableApiError(err);
      if (!shouldRetry) throw err;

      const waitMs = API_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      console.warn(
        `⚠ ${label} failed (attempt ${attempt}/${maxRetries + 1}): ${errorMessage(err)}. Retrying in ${waitMs}ms...`
      );
      await sleep(waitMs);
    }
  }
}

function normalizeBrowseCondition(condition) {
  return condition.trim().toUpperCase().replace(/\s+/g, '_');
}

// ─── Step 1: Get active market listings (price distribution) ────
async function getMarketListings(query, condition) {
  const fullQuery = SEARCH_EXCLUSIONS ? `${query} ${SEARCH_EXCLUSIONS}` : query;
  console.log(`\n📊 Fetching active market listings for "${query}" (${condition})...\n`);

  const conditionFilter = normalizeBrowseCondition(condition);
  const priceFilter = ',priceCurrency:USD';
  const allItems = [];
  const pageSize = RESULTS_PER_PAGE;
  const maxItems = 10_000; // eBay Browse API pagination cap
  let page = 0;

  while (allItems.length < maxItems) {
    try {
      const result = await callApiWithRetry(
        `Browse market listings page ${page + 1}`,
        () =>
          eBay.buy.browse.search({
            q: fullQuery,
            filter: `buyingOptions:{FIXED_PRICE},conditions:{${conditionFilter}}${priceFilter}`,
            limit: String(pageSize),
            offset: String(page * pageSize),
          })
      );

      const items = result?.itemSummaries;
      if (!items || items.length === 0) break;

      allItems.push(...items);

      const total = result?.total || 0;
      if (allItems.length >= total) break;

      page++;
    } catch (err) {
      if (allItems.length === 0) {
        throw new Error(
          `Unable to fetch market listings page ${page + 1}: ${errorMessage(err)}`
        );
      }
      console.warn(
        `⚠ Market listings fetch stopped at page ${page + 1}: ${errorMessage(err)}. Continuing with ${allItems.length} result(s).`
      );
      break;
    }
  }

  return allItems;
}

// ─── Step 2: Analyze market prices ──────────────────────────────
function analyzePrices(marketItems) {
  const prices = marketItems
    .map((item) => {
      const priceVal = item?.price?.value;
      return parseFloat(priceVal);
    })
    .filter((p) => !isNaN(p) && p > 0);

  if (prices.length === 0) {
    console.log('❌ No market price data found.');
    return null;
  }
  if (prices.length < MIN_MARKET_SAMPLE) {
    console.log(
      `❌ Not enough market listings for reliable pricing (${prices.length} found, need at least ${MIN_MARKET_SAMPLE}).`
    );
    return null;
  }

  const sorted = [...prices].sort((a, b) => a - b);

  // Raw stats (before outlier removal)
  console.log('─'.repeat(50));
  console.log('  RAW MARKET PRICES (active listings)');
  console.log('─'.repeat(50));
  console.log(`  Items analyzed:  ${prices.length}`);
  console.log(`  Average price:   ${formatCurrency(average(prices))}`);
  console.log(`  Median price:    ${formatCurrency(median(prices))}`);
  console.log(`  Low / High:      ${formatCurrency(sorted[0])} — ${formatCurrency(sorted[sorted.length - 1])}`);
  console.log('─'.repeat(50));

  // IQR outlier removal
  const { filtered, lower, upper, removedCount } = filterOutliers(prices);

  if (filtered.length === 0) {
    console.log('❌ All prices were filtered as outliers. Check your data.');
    return null;
  }
  if (filtered.length < MIN_MARKET_SAMPLE) {
    console.log(
      `❌ Too few listings after outlier filtering (${filtered.length} kept, need at least ${MIN_MARKET_SAMPLE}).`
    );
    return null;
  }

  const filteredSorted = [...filtered].sort((a, b) => a - b);
  const filteredMean = average(filtered);
  const filteredMedian = median(filtered);
  const filteredStdDevRaw = stdDev(filtered, filteredMean);
  const hasUsableStdDev =
    Number.isFinite(filteredStdDevRaw) && filteredStdDevRaw >= MIN_STD_DEV;
  const filteredStdDev = hasUsableStdDev ? filteredStdDevRaw : 0;
  const cv = hasUsableStdDev ? filteredStdDev / filteredMean : 0;

  const stats = {
    count: filtered.length,
    average: filteredMean,
    median: filteredMedian,
    stdDev: filteredStdDev,
    hasUsableStdDev,
    cv,
    low: filteredSorted[0],
    high: filteredSorted[filteredSorted.length - 1],
    p25: filteredSorted[Math.floor(filteredSorted.length * 0.25)],
    p75: filteredSorted[Math.floor(filteredSorted.length * 0.75)],
  };

  console.log(`\n  🧹 IQR FILTER: keeping ${formatCurrency(lower)} — ${formatCurrency(upper)}`);
  console.log(`     Removed ${removedCount} outlier(s)\n`);
  console.log('─'.repeat(50));
  console.log('  FILTERED MARKET VALUE');
  console.log('─'.repeat(50));
  console.log(`  Items kept:      ${stats.count} of ${prices.length}`);
  console.log(`  Average price:   ${formatCurrency(stats.average)}`);
  console.log(`  Median price:    ${formatCurrency(stats.median)}`);
  console.log(`  Std deviation:   ${formatCurrency(stats.stdDev)}`);
  console.log(`  Low / High:      ${formatCurrency(stats.low)} — ${formatCurrency(stats.high)}`);
  console.log(`  25th / 75th pct: ${formatCurrency(stats.p25)} — ${formatCurrency(stats.p75)}`);
  console.log('─'.repeat(50));

  // σ price bands
  console.log('\n  📐 PRICE BANDS');
  console.log('─'.repeat(50));
  if (stats.hasUsableStdDev) {
    console.log(`  -2σ (strong buy): ${formatCurrency(stats.median - 2 * stats.stdDev)}`);
    console.log(`  -1σ (buy):        ${formatCurrency(stats.median - 1 * stats.stdDev)}`);
    console.log(`   0  (fair value): ${formatCurrency(stats.median)}`);
    console.log(`  +1σ (overpriced): ${formatCurrency(stats.median + 1 * stats.stdDev)}`);
    console.log(`  +2σ (avoid):      ${formatCurrency(stats.median + 2 * stats.stdDev)}`);
  } else {
    const fallbackPrice = stats.median * (1 - FALLBACK_DISCOUNT_RATE);
    console.log(
      `  ⚠ Std deviation is below ${MIN_STD_DEV}; using discount scoring instead of z-score.`
    );
    console.log(
      `  Discount threshold (${(FALLBACK_DISCOUNT_RATE * 100).toFixed(0)}% below median): ${formatCurrency(fallbackPrice)}`
    );
  }
  console.log('─'.repeat(50));

  // Market quality verdict
  let marketVerdict;
  if (!stats.hasUsableStdDev) {
    marketVerdict = '⚠️  Very low variance — using discount-based scoring';
  } else if (cv < 0.3) {
    marketVerdict = '✅ Tight market — good for arbitrage';
  } else if (cv < 0.5) {
    marketVerdict = '⚠️  Moderate spread — proceed with caution';
  } else {
    marketVerdict = '❌ High variance — no reliable fair value';
  }
  const cvDisplay = stats.hasUsableStdDev ? cv.toFixed(3) : 'N/A';
  console.log(`\n  CV: ${cvDisplay}  →  ${marketVerdict}`);
  console.log('─'.repeat(50));

  return stats;
}

// ─── Step 3a: Enrich deals with sold quantity ───────────────────
async function enrichDealsWithDetails(deals) {
  console.log(
    `\n📦 Enriching ${deals.length} deals with sold quantity data...\n`
  );

  const soldByItemId = new Map();
  for (const deal of deals) {
    try {
      const details = await callApiWithRetry(
        `Browse sold quantity for ${deal.itemId}`,
        () => eBay.buy.browse.getItem(deal.itemId)
      );
      const soldQty =
        details?.estimatedAvailabilities?.[0]?.estimatedSoldQuantity;
      soldByItemId.set(deal.itemId, typeof soldQty === 'number' ? soldQty : 0);
    } catch (err) {
      soldByItemId.set(deal.itemId, null);
      console.warn(
        `⚠ Sold quantity enrichment failed for ${deal.itemId}: ${errorMessage(err)}`
      );
    }
  }

  return deals.map((deal) => ({
    ...deal,
    soldQuantity: soldByItemId.has(deal.itemId)
      ? soldByItemId.get(deal.itemId)
      : null,
  }));
}

// ─── Step 3c: Get full listing details for LLM evaluation ───────
function toArray(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value : [value];
}

async function getListingDetails(itemId) {
  const browseItem = await callApiWithRetry(`Browse details for ${itemId}`, () =>
    eBay.buy.browse.getItem(itemId)
  );

  return {
    title: browseItem.title || '',
    description: browseItem.description || browseItem.shortDescription || '',
    imageUrls: [
      browseItem?.image?.imageUrl,
      ...toArray(browseItem?.additionalImages).map((img) => img?.imageUrl),
    ].filter(Boolean),
    conditionDescription: browseItem.conditionDescription || '',
    conditionName: browseItem.condition || '',
    itemSpecifics: toArray(browseItem?.localizedAspects).map((aspect) => ({
      Name: aspect?.name || '',
      Value: toArray(aspect?.value).filter(Boolean),
    })),
    seller: {
      userId: browseItem?.seller?.username || '',
      feedbackScore: browseItem?.seller?.feedbackScore || 0,
      positiveFeedbackPercent: browseItem?.seller?.feedbackPercentage || 0,
    },
  };
}

// ─── Step 3d: Evaluate a single listing with Azure OpenAI ───────
let llmClient = null;

function getLLMClient() {
  if (llmClient) return llmClient;

  llmClient = new AzureOpenAI({
    apiVersion: '2024-10-01-preview',
    endpoint: process.env.AZURE_OPENAI_ENDPOINT,
    apiKey: process.env.AZURE_OPENAI_API_KEY,
  });

  return llmClient;
}

const VALID_LLM_VERDICTS = new Set(['BUY', 'RISKY', 'PASS']);

function parseLLMEvaluationResponse(content) {
  if (typeof content !== 'string' || content.trim().length === 0) {
    throw new Error('LLM returned an empty response payload.');
  }

  const parsed = JSON.parse(content);
  const verdict =
    typeof parsed.verdict === 'string' ? parsed.verdict.toUpperCase() : '';
  const confidence = Number(parsed.confidence);

  if (!VALID_LLM_VERDICTS.has(verdict)) {
    throw new Error(`Invalid LLM verdict: ${parsed.verdict}`);
  }
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 100) {
    throw new Error(`Invalid LLM confidence: ${parsed.confidence}`);
  }
  if (
    !Array.isArray(parsed.issues) ||
    parsed.issues.some((issue) => typeof issue !== 'string')
  ) {
    throw new Error('Invalid LLM issues payload.');
  }
  if (typeof parsed.summary !== 'string' || parsed.summary.trim().length === 0) {
    throw new Error('Invalid LLM summary payload.');
  }

  return {
    verdict,
    confidence: Math.round(confidence),
    issues: parsed.issues.map((issue) => issue.trim()).filter(Boolean),
    summary: parsed.summary.trim(),
  };
}

async function evaluateListingWithLLM(listingDetails, dealContext) {
  const client = getLLMClient();
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;

  // Strip HTML tags from description for cleaner LLM input
  const plainDescription = listingDetails.description
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 3000); // Cap at 3000 chars

  const itemSpecsText = listingDetails.itemSpecifics
    .map((spec) => `${spec.Name}: ${Array.isArray(spec.Value) ? spec.Value.join(', ') : spec.Value}`)
    .join('\n');

  const zScoreContext =
    typeof dealContext.zScore === 'number'
      ? `${dealContext.zScore.toFixed(2)} (negative = below market)`
      : 'N/A (market variance too low for z-score)';
  const discountContext = `${dealContext.discountPct.toFixed(1)}% below median`;

  // Build content array: text context + images
  const content = [
    {
      type: 'text',
      text: `You are an expert eBay arbitrage analyst specializing in evaluating "${SEARCH_QUERY}" listings for resale potential.

Your job is to determine whether this listing is actually a "${SEARCH_QUERY}" (not an accessory, case, cable, cover, or unrelated item), and if so, whether it's a good buy for resale.

LISTING DETAILS:
- Title: ${listingDetails.title}
- Condition: ${listingDetails.conditionName}
- Condition Notes: ${listingDetails.conditionDescription || 'None provided'}
- Seller: ${listingDetails.seller.userId} (${listingDetails.seller.positiveFeedbackPercent}% positive, ${listingDetails.seller.feedbackScore} feedback score)
- Item Specifics:
${itemSpecsText || 'None listed'}

DESCRIPTION:
${plainDescription || 'No description provided'}

DEAL CONTEXT:
- Listed price: $${dealContext.price.toFixed(2)}
- Market median: $${dealContext.marketMedian.toFixed(2)}
- Z-score: ${zScoreContext}
- Discount vs median: ${discountContext}
- Estimated net profit: $${dealContext.netProfit.toFixed(2)}

EVALUATE THIS LISTING FOR:
1. PRODUCT VERIFICATION: Is this actually a "${SEARCH_QUERY}"? If it's an accessory, case, cable, cover, replacement part, or different product entirely, verdict should be PASS regardless of price.
2. PHOTO ANALYSIS: Check all images for physical damage, screen issues, cracks, discoloration, missing parts, or anything that looks wrong for this specific product.
3. DESCRIPTION ANALYSIS: Look for red-flag phrases ("as-is", "for parts", "not tested", "no returns"), functional issues mentioned, missing accessories.
4. SELLER ASSESSMENT: Grammar quality, disclosure transparency, feedback score, signs of competence or potential scam.
5. COMPLETENESS: Are expected accessories included (e.g., charger, USB cable, slide cover, batteries)?
6. OVERALL VERDICT: Given the price vs. market value, is this a good buy for resale as a "${SEARCH_QUERY}"?`,
    },
  ];

  // Add listing images (up to MAX_IMAGES_PER_LISTING)
  const imageUrls = Array.isArray(listingDetails.imageUrls)
    ? listingDetails.imageUrls
    : [listingDetails.imageUrls];

  for (const url of imageUrls.slice(0, MAX_IMAGES_PER_LISTING)) {
    if (url) {
      content.push({
        type: 'image_url',
        image_url: { url },
      });
    }
  }

  const response = await callApiWithRetry(
    `Azure OpenAI listing evaluation for ${listingDetails.title.slice(0, 30) || 'listing'}`,
    () =>
      client.chat.completions.create({
        model: deployment,
        messages: [{ role: 'user', content }],
        max_completion_tokens: 800,
        response_format: {
          type: 'json_schema',
          json_schema: {
            name: 'listing_evaluation',
            strict: true,
            schema: {
              type: 'object',
              properties: {
                verdict: {
                  type: 'string',
                  enum: ['BUY', 'RISKY', 'PASS'],
                  description:
                    'BUY = safe to purchase for resale, RISKY = proceed with caution, PASS = do not buy',
                },
                confidence: {
                  type: 'number',
                  minimum: 0,
                  maximum: 100,
                  description: 'Confidence in verdict from 0-100',
                },
                issues: {
                  type: 'array',
                  items: { type: 'string' },
                  description: 'List of specific issues found',
                },
                summary: {
                  type: 'string',
                  description: 'One-sentence summary of the evaluation',
                },
              },
              required: ['verdict', 'confidence', 'issues', 'summary'],
              additionalProperties: false,
            },
          },
        },
      }),
    { timeoutMs: LLM_TIMEOUT_MS }
  );

  const responseContent = response?.choices?.[0]?.message?.content;
  return parseLLMEvaluationResponse(responseContent);
}

// ─── Step 3e: Evaluate all deals with LLM ───────────────────────
const LLM_CONCURRENCY = 5;

async function evaluateDealsWithLLM(deals, marketStats) {
  // Check if Azure OpenAI is configured
  if (
    !process.env.AZURE_OPENAI_ENDPOINT ||
    !process.env.AZURE_OPENAI_API_KEY ||
    !process.env.AZURE_OPENAI_DEPLOYMENT
  ) {
    console.log(
      '\n💡 LLM evaluation skipped — set AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY, and AZURE_OPENAI_DEPLOYMENT in .env to enable.\n'
    );
    return deals;
  }

  const toEvaluate = deals.slice(0, MAX_LLM_CALLS);
  if (toEvaluate.length < deals.length) {
    console.log(
      `  ℹ️  ${deals.length} deals passed the statistical filter; evaluating the top ${toEvaluate.length} by composite score (budget cap: ${MAX_LLM_CALLS}).`
    );
    console.log(
      `     Remaining ${deals.length - toEvaluate.length} deal(s) will use price-signal-only recommendations.\n`
    );
  }
  console.log(
    `\n🤖 Evaluating ${toEvaluate.length} deals with Azure OpenAI (${LLM_CONCURRENCY} parallel)...\n`
  );

  let completed = 0;

  async function evaluateOne(deal, index) {
    const label = `  [${index + 1}/${toEvaluate.length}] ${deal.title.substring(0, 40)}...`;
    try {
      const details = await getListingDetails(deal.itemId);
      const evaluation = await evaluateListingWithLLM(details, {
        price: deal.price,
        marketMedian: marketStats.median,
        zScore: deal.zScore,
        discountPct: deal.discountPct,
        netProfit: deal.netProfit,
      });

      deal.llmVerdict = evaluation.verdict;
      deal.llmConfidence = evaluation.confidence;
      deal.llmIssues = evaluation.issues;
      deal.llmSummary = evaluation.summary;

      const verdictIcon =
        evaluation.verdict === 'BUY' ? '🟢' :
        evaluation.verdict === 'RISKY' ? '🟡' : '🔴';
      completed++;
      console.log(`${label} ${verdictIcon} ${evaluation.verdict} (${evaluation.confidence}%) [${completed}/${toEvaluate.length}]`);
    } catch (err) {
      deal.llmVerdict = 'N/A';
      deal.llmConfidence = 0;
      deal.llmIssues = [];
      deal.llmSummary = `Error: ${errorMessage(err)}`;
      completed++;
      console.log(`${label} ⚪ Error: ${errorMessage(err).substring(0, 60)} [${completed}/${toEvaluate.length}]`);
    }
  }

  // Process in batches of LLM_CONCURRENCY
  for (let i = 0; i < toEvaluate.length; i += LLM_CONCURRENCY) {
    const batch = toEvaluate.slice(i, i + LLM_CONCURRENCY);
    await Promise.all(batch.map((deal, j) => evaluateOne(deal, i + j)));
  }

  return deals;
}

// ─── Step 3: Find underpriced active listings ───────────────────
async function findDeals(query, condition, marketStats) {
  const hasUsableStdDev = marketStats.hasUsableStdDev;
  const rawMaxPrice = hasUsableStdDev
    ? marketStats.median + MIN_Z_SCORE * marketStats.stdDev
    : marketStats.median * (1 - FALLBACK_DISCOUNT_RATE);
  const maxPrice = Math.max(1, Math.floor(rawMaxPrice));



  const conditionFilter = normalizeBrowseCondition(condition);
  const thresholdExplanation = hasUsableStdDev
    ? `(z ≤ ${MIN_Z_SCORE}, i.e. ${Math.abs(MIN_Z_SCORE)}σ below ${formatCurrency(marketStats.median)} median)`
    : `(${(FALLBACK_DISCOUNT_RATE * 100).toFixed(0)}% below ${formatCurrency(marketStats.median)} median fallback)`;

  console.log(
    `\n🔎 Searching active listings under ${formatCurrency(maxPrice)} ` +
      `${thresholdExplanation}...\n`
  );

  try {
    const fullQuery = SEARCH_EXCLUSIONS ? `${query} ${SEARCH_EXCLUSIONS}` : query;
    const priceFilter = `price:[..${maxPrice}]`;
    const allDealItems = [];
    const maxItems = 10_000;
    let page = 0;

    while (allDealItems.length < maxItems) {
      try {
        const results = await callApiWithRetry(
          `Browse deal search page ${page + 1}`,
          () =>
            eBay.buy.browse.search({
              q: fullQuery,
              filter: `buyingOptions:{FIXED_PRICE},conditions:{${conditionFilter}},${priceFilter},priceCurrency:USD`,
              sort: 'price',
              limit: String(RESULTS_PER_PAGE),
              offset: String(page * RESULTS_PER_PAGE),
            })
        );

        const items = results?.itemSummaries;
        if (!items || items.length === 0) break;

        allDealItems.push(...items);

        const total = results?.total || 0;
        if (allDealItems.length >= total) break;

        page++;
      } catch (err) {
        if (allDealItems.length === 0) throw err;
        console.warn(
          `⚠ Deal search stopped at page ${page + 1}: ${errorMessage(err)}. Continuing with ${allDealItems.length} result(s).`
        );
        break;
      }
    }

    const items = allDealItems;
    if (items.length === 0) {
      console.log('😕 No deals found right now. Try again later!\n');
      return [];
    }

    const deals = items
      .map((item) => {
        const price = parseFloat(item?.price?.value);
        if (!Number.isFinite(price) || price <= 0) return null;

        const discountPct =
          ((marketStats.median - price) / marketStats.median) * 100;
        const zScore = hasUsableStdDev
          ? (price - marketStats.median) / marketStats.stdDev
          : null;
        const priceScore = hasUsableStdDev ? zScore : -discountPct;
        const grossProfit = marketStats.median - price;
        const fees = marketStats.median * EBAY_FEE_RATE;
        const netProfit = grossProfit - fees;

        let signal;
        if (hasUsableStdDev) {
          if (zScore <= -2) signal = '🔥 Strong buy';
          else if (zScore <= -1) signal = '✅ Buy';
          else signal = '⚠️  Marginal';
        } else {
          if (discountPct >= 20) signal = '🔥 Strong buy';
          else if (discountPct >= 10) signal = '✅ Buy';
          else signal = '⚠️  Marginal';
        }

        return {
          itemId: item.itemId,
          title: item.title,
          price,
          zScore,
          discountPct,
          priceScore,
          signal,
          grossProfit,
          netProfit,
          link: item.itemWebUrl,
        };
      })
      .filter(Boolean);

    if (deals.length === 0) {
      console.log('😕 No listings with valid price data were returned.\n');
      return [];
    }

    // Sort by score first, then enrich top deals with sold quantity
    deals.sort((a, b) => a.priceScore - b.priceScore);
    const enrichedDeals = await enrichDealsWithDetails(deals);

    // Composite score: price score adjusted by sold volume (used in final ranking)
    enrichedDeals.forEach((deal) => {
      const soldForScore = typeof deal.soldQuantity === 'number' ? deal.soldQuantity : 0;
      deal.compositeScore = deal.priceScore - 0.1 * soldForScore;
    });

    // Sort by composite score (best deals first) before LLM evaluation
    enrichedDeals.sort((a, b) => a.compositeScore - b.compositeScore);

    // LLM evaluation (if configured)
    await evaluateDealsWithLLM(enrichedDeals, marketStats);

    const hasLLM = enrichedDeals.some((d) => d.llmVerdict && d.llmVerdict !== 'N/A');
    const scoreHeader = hasUsableStdDev ? 'Z-SCORE' : 'DISC%';

    // ── Compute final recommendation combining price signal + LLM verdict ──
    enrichedDeals.forEach((deal) => {
      const priceRank =
        deal.signal.includes('Strong') ? 3 :
        deal.signal.includes('Buy') ? 2 : 1;

      const llmRank =
        deal.llmVerdict === 'BUY' ? 3 :
        deal.llmVerdict === 'RISKY' ? 2 :
        deal.llmVerdict === 'PASS' ? 0 : -1; // N/A or error = -1

      const confidence = deal.llmConfidence || 0;

      // Combined score: price rank (0-3) + LLM rank (0-3) + confidence bonus
      const effectiveLLMRank = llmRank === -1 ? 0 : llmRank;
      deal.finalScore = priceRank + effectiveLLMRank + (confidence / 100);

      if (llmRank === 0) {
        // LLM said PASS — skip regardless of price
        deal.finalRec = '❌ SKIP';
      } else if (llmRank === -1) {
        // LLM failed/skipped — fall back to price signal only
        deal.finalRec = priceRank >= 3 ? '⚠️  CONSIDER' : priceRank >= 2 ? '⚠️  CONSIDER' : '❌ SKIP';
      } else if (llmRank === 3 && priceRank >= 2) {
        deal.finalRec = '🏆 STRONG BUY';
      } else if (llmRank === 3) {
        deal.finalRec = '✅ BUY';
      } else if (llmRank === 2 && priceRank >= 2) {
        deal.finalRec = '⚠️  CONSIDER';
      } else if (!hasLLM) {
        // No LLM configured at all — fall back to price signal only
        deal.finalRec = priceRank >= 3 ? '✅ BUY' : priceRank >= 2 ? '⚠️  CONSIDER' : '❌ SKIP';
      } else {
        deal.finalRec = '❌ SKIP';
      }
    });

    // Sort by final score descending (best deals first)
    enrichedDeals.sort((a, b) => b.finalScore - a.finalScore);

    // ── Full analysis table ──
    console.log(`\n📊 Full Analysis — ${enrichedDeals.length} deals (best first):\n`);
    const recCol = hasLLM ? 'RECOMMENDATION'.padEnd(18) : '';
    const header =
      recCol +
      scoreHeader.padEnd(10) +
      'SOLD'.padEnd(7) +
      (hasLLM ? 'VERDICT'.padEnd(14) : '') +
      'SIGNAL'.padEnd(16) +
      'PRICE'.padEnd(10) +
      'NET PROFIT'.padEnd(12) +
      'TITLE'.padEnd(45) +
      'LINK';
    console.log(header);
    console.log('─'.repeat(150));

    enrichedDeals.forEach((deal) => {
      let verdictCol = '';
      if (hasLLM) {
        const icon =
          deal.llmVerdict === 'BUY' ? '🟢' :
          deal.llmVerdict === 'RISKY' ? '🟡' :
          deal.llmVerdict === 'PASS' ? '🔴' : '⚪';
        verdictCol = `${icon} ${deal.llmVerdict || 'N/A'}`.padEnd(14);
      }
      const scoreCol = hasUsableStdDev
        ? deal.zScore.toFixed(2)
        : `${deal.discountPct.toFixed(1)}%`;
      const soldCol =
        typeof deal.soldQuantity === 'number' ? String(deal.soldQuantity) : '?';
      const recColVal = hasLLM ? deal.finalRec.padEnd(18) : '';

      console.log(
        recColVal +
          scoreCol.padEnd(10) +
          soldCol.padEnd(7) +
          verdictCol +
          deal.signal.padEnd(16) +
          formatCurrency(deal.price).padEnd(10) +
          `${deal.netProfit > 0 ? '+' : ''}${formatCurrency(deal.netProfit)}`.padEnd(12) +
          deal.title.substring(0, 42).padEnd(45) +
          deal.link
      );
    });

    console.log('─'.repeat(150));

    // ── Legend ──
    console.log(`\n💡 Column guide:`);
    if (hasUsableStdDev) {
      console.log(`   Z-SCORE  = (price - median) / std dev — lower is cheaper`);
    } else {
      console.log(`   DISC%    = ((median - price) / median) × 100`);
    }
    console.log(`   SOLD     = units sold on this listing (demand signal)`);
    if (hasLLM) {
      console.log(`   VERDICT  = LLM photo analysis: 🟢 BUY | 🟡 RISKY | 🔴 PASS`);
      console.log(`   RECOMMENDATION = combined price + LLM + confidence score`);
    }
    console.log(`   NET PROFIT = (median - price) minus ~${EBAY_FEE_RATE * 100}% eBay fees (excl. shipping)\n`);

    // ── Action Items: only listings worth buying ──
    const actionable = enrichedDeals.filter(
      (d) => d.finalRec === '🏆 STRONG BUY' || d.finalRec === '✅ BUY'
    );
    const consider = enrichedDeals.filter(
      (d) => d.finalRec === '⚠️  CONSIDER'
    );

    console.log('═'.repeat(70));
    console.log('  🎯 ACTION ITEMS — Listings to buy NOW');
    console.log('═'.repeat(70));

    if (actionable.length === 0) {
      console.log('\n  No strong recommendations right now.');
      console.log('  The market may be efficiently priced, or all cheap listings have issues.');
    } else {
      actionable.forEach((deal, i) => {
        const rec = deal.finalRec;
        const scoreSummary = hasUsableStdDev
          ? `z=${deal.zScore.toFixed(2)}`
          : `${deal.discountPct.toFixed(1)}% off`;
        console.log(`\n  ${rec}  [${i + 1}]`);
        console.log(`  📦 ${deal.title.substring(0, 70)}`);
        console.log(`  💰 ${formatCurrency(deal.price)} → est. profit ${deal.netProfit > 0 ? '+' : ''}${formatCurrency(deal.netProfit)} (${scoreSummary})`);
        if (deal.llmSummary) console.log(`  🤖 ${deal.llmSummary}`);
        console.log(`  🔗 ${deal.link}`);
      });
    }

    if (consider.length > 0) {
      console.log('\n' + '─'.repeat(70));
      console.log('  ⚠️  WORTH CONSIDERING (proceed with caution)');
      console.log('─'.repeat(70));
      consider.forEach((deal, i) => {
        const scoreSummary = hasUsableStdDev
          ? `z=${deal.zScore.toFixed(2)}`
          : `${deal.discountPct.toFixed(1)}% off`;
        console.log(`\n  [${i + 1}] ${deal.title.substring(0, 65)}`);
        console.log(`      ${formatCurrency(deal.price)} | profit: ${deal.netProfit > 0 ? '+' : ''}${formatCurrency(deal.netProfit)} (${scoreSummary})`);
        if (deal.llmSummary) console.log(`      🤖 ${deal.llmSummary}`);
        if (deal.llmIssues?.length > 0) {
          deal.llmIssues.forEach((issue) => console.log(`      ⚠ ${issue}`));
        }
        console.log(`      🔗 ${deal.link}`);
      });
    }

    const skipped = enrichedDeals.filter((d) => d.finalRec === '❌ SKIP').length;
    console.log(`\n  📊 Summary: ${actionable.length} BUY | ${consider.length} CONSIDER | ${skipped} SKIP out of ${enrichedDeals.length} deals`);
    console.log('═'.repeat(70) + '\n');

    return enrichedDeals;
  } catch (err) {
    console.error('Error searching active listings:', errorMessage(err));
    return [];
  }
}

// ─── Main ───────────────────────────────────────────────────────
async function main() {
  console.log('═'.repeat(50));
  console.log('  eBay Deal Finder — Arbitrage Research Tool');
  console.log('═'.repeat(50));
  console.log(`  Query:     "${SEARCH_QUERY}"`);
  console.log(`  Condition: ${CONDITION}`);
  console.log(`  Min z:     ${MIN_Z_SCORE} (${Math.abs(MIN_Z_SCORE)}σ below median)`);
  console.log(`  Strategy:  Active market price distribution`);
  console.log('═'.repeat(50));

  // Step 1: Get active market listings for price distribution
  const marketItems = await getMarketListings(SEARCH_QUERY, CONDITION);

  if (marketItems.length === 0) {
    console.log('❌ No market listings found. Check your query or API credentials.');
    process.exit(1);
  }

  // Step 2: Analyze market prices
  const stats = analyzePrices(marketItems);
  if (!stats) process.exit(1);

  // Step 3: Find deals
  await findDeals(SEARCH_QUERY, CONDITION, stats);
}

main().catch((err) => {
  console.error('\n❌ Fatal error:', err.message);
  if (err.message.includes('Invalid access token') || err.message.includes('appId')) {
    console.error(
      '\n💡 Make sure your .env file has valid EBAY_APP_ID and EBAY_CERT_ID values.'
    );
    console.error('   Get them at: https://developer.ebay.com\n');
  }
  process.exit(1);
});
