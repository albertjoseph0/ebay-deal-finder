import eBayApi from 'ebay-api';
import { AzureOpenAI } from 'openai';

// ─── Configuration ──────────────────────────────────────────────
const SEARCH_QUERY = 'TI-84 Plus calculator';
const CONDITION = 'Used';
const MIN_Z_SCORE = -1.0; // Show listings at or below 1 std dev under median
const EBAY_FEE_RATE = 0.13; // ~13% eBay seller fees
const RESULTS_PER_PAGE = 100;
const MAX_ENRICH = 20; // How many top deals to enrich with getItem() details
const MAX_LLM_EVAL = 10; // How many deals to evaluate with LLM
const MAX_IMAGES_PER_LISTING = 5; // Max images to send to LLM per listing

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

// ─── Step 1: Get sold prices (market value) ─────────────────────
async function getSoldPrices(query, condition) {
  console.log(`\n📊 Fetching sold listings for "${query}" (${condition})...\n`);

  const allItems = [];
  let page = 1;
  const maxPages = 3; // up to 300 results

  while (page <= maxPages) {
    try {
      const result = await eBay.finding.findItemsAdvanced({
        keywords: query,
        itemFilter: [
          { name: 'SoldItemsOnly', value: 'true' },
          { name: 'Condition', value: condition },
        ],
        sortOrder: 'EndTimeSoonest',
        paginationInput: {
          entriesPerPage: RESULTS_PER_PAGE,
          pageNumber: page,
        },
      });

      const items = result?.searchResult?.item;
      if (!items || items.length === 0) break;

      allItems.push(...items);

      const totalPages = parseInt(
        result?.paginationOutput?.totalPages || '1',
        10
      );
      if (page >= totalPages) break;
      page++;
    } catch (err) {
      console.error(`Error fetching page ${page}:`, err.message);
      break;
    }
  }

  return allItems;
}

// ─── Step 2: Analyze sold prices ────────────────────────────────
function analyzePrices(soldItems) {
  const prices = soldItems
    .map((item) => {
      const priceVal =
        item?.sellingStatus?.currentPrice?.value ??
        item?.sellingStatus?.currentPrice;
      return parseFloat(typeof priceVal === 'object' ? priceVal.value : priceVal);
    })
    .filter((p) => !isNaN(p) && p > 0);

  if (prices.length === 0) {
    console.log('❌ No sold price data found.');
    return null;
  }

  const sorted = [...prices].sort((a, b) => a - b);

  // Raw stats (before outlier removal)
  console.log('─'.repeat(50));
  console.log('  RAW SOLD PRICES (last ~90 days)');
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

  const filteredSorted = [...filtered].sort((a, b) => a - b);
  const filteredMean = average(filtered);
  const filteredMedian = median(filtered);
  const filteredStdDev = stdDev(filtered, filteredMean);
  const cv = filteredStdDev / filteredMean;

  const stats = {
    count: filtered.length,
    average: filteredMean,
    median: filteredMedian,
    stdDev: filteredStdDev,
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
  console.log(`  -2σ (strong buy): ${formatCurrency(stats.median - 2 * stats.stdDev)}`);
  console.log(`  -1σ (buy):        ${formatCurrency(stats.median - 1 * stats.stdDev)}`);
  console.log(`   0  (fair value): ${formatCurrency(stats.median)}`);
  console.log(`  +1σ (overpriced): ${formatCurrency(stats.median + 1 * stats.stdDev)}`);
  console.log(`  +2σ (avoid):      ${formatCurrency(stats.median + 2 * stats.stdDev)}`);
  console.log('─'.repeat(50));

  // Market quality verdict
  let marketVerdict;
  if (cv < 0.3) {
    marketVerdict = '✅ Tight market — good for arbitrage';
  } else if (cv < 0.5) {
    marketVerdict = '⚠️  Moderate spread — proceed with caution';
  } else {
    marketVerdict = '❌ High variance — no reliable fair value';
  }
  console.log(`\n  CV: ${cv.toFixed(3)}  →  ${marketVerdict}`);
  console.log('─'.repeat(50));

  return stats;
}

// ─── Step 3a: Enrich deals with sold quantity ───────────────────
async function enrichDealsWithDetails(deals) {
  const topDeals = deals.slice(0, MAX_ENRICH);

  console.log(
    `\n📦 Enriching top ${topDeals.length} deals with sold quantity data...\n`
  );

  const enriched = [];
  for (const deal of topDeals) {
    try {
      const details = await eBay.buy.browse.getItem(deal.itemId);
      const soldQty =
        details?.estimatedAvailabilities?.[0]?.estimatedSoldQuantity || 0;
      enriched.push({ ...deal, soldQuantity: soldQty });
    } catch {
      enriched.push({ ...deal, soldQuantity: 0 });
    }
  }

  return enriched;
}

// ─── Step 3b: Get full listing details for LLM evaluation ───────
async function getListingDetails(itemId) {
  // Extract numeric ID from Browse API format (e.g. "v1|123456|0" → "123456")
  const numericId = itemId.includes('|') ? itemId.split('|')[1] : itemId;

  const result = await eBay.shopping.GetSingleItem({
    ItemID: numericId,
    IncludeSelector: 'Details,Description,ItemSpecifics',
  });

  const item = result?.Item || result;

  return {
    title: item?.Title || '',
    description: item?.Description || '',
    imageUrls: item?.PictureURL || [],
    conditionDescription: item?.ConditionDescription || '',
    conditionName: item?.ConditionDisplayName || '',
    itemSpecifics: item?.ItemSpecifics?.NameValueList || [],
    seller: {
      userId: item?.Seller?.UserID || '',
      feedbackScore: item?.Seller?.FeedbackScore || 0,
      positiveFeedbackPercent: item?.Seller?.PositiveFeedbackPercent || 0,
    },
  };
}

// ─── Step 3c: Evaluate a single listing with Azure OpenAI ───────
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

  // Build content array: text context + images
  const content = [
    {
      type: 'text',
      text: `You are an expert eBay arbitrage analyst evaluating a listing for resale potential.

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
- Z-score: ${dealContext.zScore.toFixed(2)} (negative = below market)
- Estimated net profit: $${dealContext.netProfit.toFixed(2)}

EVALUATE THIS LISTING FOR:
1. PHOTO ANALYSIS: Check all images for physical damage, screen issues, cracks, discoloration, missing parts, or anything that looks wrong
2. DESCRIPTION ANALYSIS: Look for red-flag phrases ("as-is", "for parts", "not tested", "no returns"), functional issues mentioned, missing accessories
3. SELLER ASSESSMENT: Grammar quality, disclosure transparency, feedback score, signs of competence or potential scam
4. COMPLETENESS: Are cables, charger, case, manual, or other accessories included?
5. OVERALL VERDICT: Given the price vs. market value, is this a good buy for resale?`,
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

  const response = await client.chat.completions.create({
    model: deployment,
    messages: [{ role: 'user', content }],
    max_tokens: 800,
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
              description: 'BUY = safe to purchase for resale, RISKY = proceed with caution, PASS = do not buy',
            },
            confidence: {
              type: 'number',
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
  });

  return JSON.parse(response.choices[0].message.content);
}

// ─── Step 3d: Evaluate all deals with LLM ───────────────────────
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

  const toEvaluate = deals.slice(0, MAX_LLM_EVAL);
  console.log(
    `\n🤖 Evaluating top ${toEvaluate.length} deals with Azure OpenAI (GPT-5.4-mini)...\n`
  );

  for (let i = 0; i < toEvaluate.length; i++) {
    const deal = toEvaluate[i];
    const label = `  [${i + 1}/${toEvaluate.length}] ${deal.title.substring(0, 40)}...`;

    try {
      process.stdout.write(`${label} `);

      const details = await getListingDetails(deal.itemId);
      const evaluation = await evaluateListingWithLLM(details, {
        price: deal.price,
        marketMedian: marketStats.median,
        zScore: deal.zScore,
        netProfit: deal.netProfit,
      });

      deal.llmVerdict = evaluation.verdict;
      deal.llmConfidence = evaluation.confidence;
      deal.llmIssues = evaluation.issues;
      deal.llmSummary = evaluation.summary;

      const verdictIcon =
        evaluation.verdict === 'BUY' ? '🟢' :
        evaluation.verdict === 'RISKY' ? '🟡' : '🔴';
      console.log(`${verdictIcon} ${evaluation.verdict} (${evaluation.confidence}%)`);
    } catch (err) {
      deal.llmVerdict = 'N/A';
      deal.llmConfidence = 0;
      deal.llmIssues = [];
      deal.llmSummary = `Error: ${err.message}`;
      console.log(`⚪ Error: ${err.message.substring(0, 60)}`);
    }
  }

  return deals;
}

// ─── Step 3b: Find underpriced active listings ──────────────────
async function findDeals(query, condition, marketStats) {
  const maxPrice = Math.floor(
    marketStats.median + MIN_Z_SCORE * marketStats.stdDev
  );

  console.log(
    `\n🔎 Searching active listings under ${formatCurrency(maxPrice)} ` +
      `(z ≤ ${MIN_Z_SCORE}, i.e. ${Math.abs(MIN_Z_SCORE)}σ below ${formatCurrency(marketStats.median)} median)...\n`
  );

  try {
    const results = await eBay.buy.browse.search({
      q: query,
      filter: `conditions:{${condition.toUpperCase()}},price:[..${maxPrice}],priceCurrency:USD`,
      sort: 'price',
      limit: '50',
    });

    const items = results?.itemSummaries;
    if (!items || items.length === 0) {
      console.log('😕 No deals found right now. Try again later!\n');
      return [];
    }

    const deals = items.map((item) => {
      const price = parseFloat(item.price.value);
      const zScore = (price - marketStats.median) / marketStats.stdDev;
      const grossProfit = marketStats.median - price;
      const fees = marketStats.median * EBAY_FEE_RATE;
      const netProfit = grossProfit - fees;

      let signal;
      if (zScore <= -2) signal = '🔥 Strong buy';
      else if (zScore <= -1) signal = '✅ Buy';
      else signal = '⚠️  Marginal';

      return {
        itemId: item.itemId,
        title: item.title,
        price,
        zScore,
        signal,
        grossProfit,
        netProfit,
        link: item.itemWebUrl,
      };
    });

    // Sort by z-score first, then enrich top deals with sold quantity
    deals.sort((a, b) => a.zScore - b.zScore);
    const enrichedDeals = await enrichDealsWithDetails(deals);

    // Composite score: z-score adjusted by sold volume
    enrichedDeals.forEach((deal) => {
      deal.compositeScore = deal.zScore - 0.1 * deal.soldQuantity;
    });
    enrichedDeals.sort((a, b) => a.compositeScore - b.compositeScore);

    // LLM evaluation (if configured)
    await evaluateDealsWithLLM(enrichedDeals, marketStats);

    const hasLLM = enrichedDeals.some((d) => d.llmVerdict && d.llmVerdict !== 'N/A');

    console.log(`\n🔥 Top ${enrichedDeals.length} deals (ranked by z-score + volume):\n`);
    const header =
      'Z-SCORE'.padEnd(10) +
      'SOLD'.padEnd(7) +
      (hasLLM ? 'VERDICT'.padEnd(14) : '') +
      'SIGNAL'.padEnd(16) +
      'PRICE'.padEnd(10) +
      'NET PROFIT'.padEnd(12) +
      'TITLE'.padEnd(45) +
      'LINK';
    console.log(header);
    console.log('─'.repeat(hasLLM ? 149 : 135));

    enrichedDeals.forEach((deal) => {
      let verdictCol = '';
      if (hasLLM) {
        const icon =
          deal.llmVerdict === 'BUY' ? '🟢' :
          deal.llmVerdict === 'RISKY' ? '🟡' :
          deal.llmVerdict === 'PASS' ? '🔴' : '⚪';
        verdictCol = `${icon} ${deal.llmVerdict || 'N/A'}`.padEnd(14);
      }

      console.log(
        deal.zScore.toFixed(2).padEnd(10) +
          String(deal.soldQuantity).padEnd(7) +
          verdictCol +
          deal.signal.padEnd(16) +
          formatCurrency(deal.price).padEnd(10) +
          `${deal.netProfit > 0 ? '+' : ''}${formatCurrency(deal.netProfit)}`.padEnd(12) +
          deal.title.substring(0, 42).padEnd(45) +
          deal.link
      );
    });

    console.log('\n' + '─'.repeat(hasLLM ? 149 : 135));
    console.log(
      `\n💡 Z-SCORE = (listing price - median) / std dev`
    );
    console.log(
      `   SOLD = units sold on this active listing (validated demand)`
    );
    if (hasLLM) {
      console.log(
        `   VERDICT = LLM evaluation: 🟢 BUY (safe) | 🟡 RISKY (caution) | 🔴 PASS (avoid)`
      );
    }
    console.log(
      `   Ranking = z-score adjusted by sold volume (high-volume deals rank higher)`
    );
    console.log(
      `   NET PROFIT = (median - price) minus ~${EBAY_FEE_RATE * 100}% eBay fees (shipping not included)\n`
    );

    // Print detailed LLM summaries if available
    if (hasLLM) {
      console.log('═'.repeat(60));
      console.log('  🤖 DETAILED LLM EVALUATION SUMMARIES');
      console.log('═'.repeat(60));
      enrichedDeals
        .filter((d) => d.llmVerdict && d.llmVerdict !== 'N/A')
        .forEach((deal, i) => {
          const icon =
            deal.llmVerdict === 'BUY' ? '🟢' :
            deal.llmVerdict === 'RISKY' ? '🟡' : '🔴';
          console.log(`\n  ${icon} [${i + 1}] ${deal.title.substring(0, 60)}`);
          console.log(`     Price: ${formatCurrency(deal.price)} | Z: ${deal.zScore.toFixed(2)} | Confidence: ${deal.llmConfidence}%`);
          console.log(`     ${deal.llmSummary}`);
          if (deal.llmIssues?.length > 0) {
            deal.llmIssues.forEach((issue) => {
              console.log(`     ⚠ ${issue}`);
            });
          }
        });
      console.log('\n' + '═'.repeat(60));
    }

    return enrichedDeals;
  } catch (err) {
    console.error('Error searching active listings:', err.message);
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
  console.log('═'.repeat(50));

  // Step 1: Get sold data
  const soldItems = await getSoldPrices(SEARCH_QUERY, CONDITION);

  if (soldItems.length === 0) {
    console.log('❌ No sold items found. Check your query or API credentials.');
    process.exit(1);
  }

  // Step 2: Analyze market prices
  const stats = analyzePrices(soldItems);
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
